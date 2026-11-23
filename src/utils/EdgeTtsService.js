/**
 * File: src/utils/EdgeTtsService.js
 * Description: Microsoft Edge-TTS speech synthesis wrapper for OpenAI /v1/audio/speech
 */

const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");

const EDGE_WSS_URL = "wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1";
const EDGE_SEC_MS_GEC_VERSION = "2-143.0.3650.96";
const DEFAULT_EDGE_VOICE = "zh-CN-XiaoxiaoNeural";
const SYNTHESIS_TIMEOUT_MS = 30000;

// Route msedge-tts through Microsoft's current production WSS endpoint
MsEdgeTTS.WSS_URL = EDGE_WSS_URL;
MsEdgeTTS.getSynthUrl = async function getSynthUrl() {
    const requestId = MsEdgeTTS.generateUUID();
    const secMsGec = await MsEdgeTTS.generateSecMsGec(this.TRUSTED_CLIENT_TOKEN);
    return (
        `${this.WSS_URL}?Ocp-Apim-Subscription-Key=${this.TRUSTED_CLIENT_TOKEN}` +
        `&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${EDGE_SEC_MS_GEC_VERSION}&ConnectionId=${requestId}`
    );
};

// OpenAI voice names mapped to Chinese/bilingual neural voices by default
const OPENAI_VOICE_TO_EDGE_MAP = {
    alloy: "zh-CN-XiaoxiaoNeural",
    ash: "zh-CN-YunjianNeural",
    ballad: "zh-CN-XiaoyiNeural",
    coral: "zh-CN-XiaoxiaoNeural",
    echo: "zh-CN-YunxiNeural",
    fable: "zh-CN-XiaoyiNeural",
    nova: "zh-CN-XiaoxiaoNeural",
    onyx: "zh-CN-YunjianNeural",
    sage: "zh-CN-YunyangNeural",
    shimmer: "zh-TW-HsiaoChenNeural",
    verse: "zh-CN-YunxiNeural",
};

/**
 * Resolve OpenAI or native Microsoft Edge voice name.
 * @param {string} voice
 * @param {string} [defaultVoice="zh-CN-XiaoxiaoNeural"]
 * @returns {string}
 */
function resolveVoice(voice, defaultVoice = DEFAULT_EDGE_VOICE) {
    const fallback = typeof defaultVoice === "string" && defaultVoice.trim() ? defaultVoice.trim() : DEFAULT_EDGE_VOICE;
    if (typeof voice !== "string" || !voice.trim()) {
        return fallback;
    }

    const trimmed = voice.trim();
    const mapped = OPENAI_VOICE_TO_EDGE_MAP[trimmed.toLowerCase()];
    if (mapped) {
        return mapped;
    }

    // Native Microsoft Edge voice names match locale-Region-VoiceName and work with MsEdgeTTS.VOICE_LANG_REGEX
    if (
        MsEdgeTTS.VOICE_LANG_REGEX.test(trimmed) &&
        (trimmed.includes("Neural") || /^[a-z]{2,3}-[A-Z]{2}/.test(trimmed))
    ) {
        return trimmed;
    }

    return fallback;
}

/**
 * Convert OpenAI numeric speed (0.25 - 4.0) into Edge-TTS SSML rate percentage string.
 * Clamped to [0.5, 2.0] for reliable synthesis quality.
 * @param {number|string} speed
 * @returns {string}
 */
function resolveRate(speed) {
    const numericSpeed = typeof speed === "number" ? speed : Number(speed);
    if (!Number.isFinite(numericSpeed) || numericSpeed <= 0) {
        return "+0%";
    }

    const clamped = Math.min(2.0, Math.max(0.5, numericSpeed));
    const percentage = Math.round((clamped - 1) * 100);
    return `${percentage >= 0 ? "+" : ""}${percentage}%`;
}

/**
 * Escape XML reserved characters so plain text does not break MsEdgeTTS's SSML template.
 * @param {string} text
 * @returns {string}
 */
function escapeXml(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Execute a single Edge-TTS synthesis attempt with isolated connection and timeout cleanup.
 * @param {string} escapedText
 * @param {string} voiceName
 * @param {string} rate
 * @returns {Promise<Buffer>}
 */
async function synthesizeOnce(escapedText, voiceName, rate) {
    const tts = new MsEdgeTTS({
        connectionTimeoutMs: 10000,
        synthesisTimeoutMs: 25000,
    });

    let timeoutHandle = null;
    let audioStream = null;

    try {
        const synthPromise = (async () => {
            await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
            const streamResult = tts.toStream(escapedText, { rate });
            audioStream = streamResult.audioStream;

            const chunks = [];
            await new Promise((resolve, reject) => {
                audioStream.on("data", chunk => chunks.push(chunk));
                audioStream.once("end", resolve);
                audioStream.once("error", reject);
            });

            const buffer = Buffer.concat(chunks);
            if (buffer.length === 0) {
                throw new Error("Edge-TTS returned empty audio data.");
            }
            return buffer;
        })();

        const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => {
                if (audioStream && !audioStream.destroyed) {
                    audioStream.destroy(new Error(`Edge-TTS synthesis timed out after ${SYNTHESIS_TIMEOUT_MS}ms.`));
                }
                reject(new Error(`Edge-TTS synthesis timed out after ${SYNTHESIS_TIMEOUT_MS}ms.`));
            }, SYNTHESIS_TIMEOUT_MS);
        });

        return await Promise.race([synthPromise, timeoutPromise]);
    } finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
        try {
            tts.close();
        } catch {
            // Ignore cleanup errors on already-closed sockets
        }
    }
}

/**
 * Synthesize speech using Microsoft Edge-TTS with one automatic retry on failure.
 * @param {object} params
 * @param {string} params.input - Plain text to synthesize
 * @param {string} [params.voice] - OpenAI or Edge voice name
 * @param {string} [params.defaultVoice="zh-CN-XiaoxiaoNeural"] - Fallback Edge voice
 * @param {number|string} [params.speed] - OpenAI speed multiplier
 * @param {string} [params.responseFormat="mp3"] - Requested audio format
 * @param {object} [params.logger=null] - Logger instance
 * @returns {Promise<{ buffer: Buffer, contentType: string, format: string, rate: string, voice: string }>}
 */
async function synthesize({
    defaultVoice = DEFAULT_EDGE_VOICE,
    input,
    logger = null,
    responseFormat = "mp3",
    speed,
    voice,
}) {
    const requestedFormat =
        typeof responseFormat === "string" && responseFormat.trim() ? responseFormat.trim().toLowerCase() : "mp3";

    if (requestedFormat !== "mp3") {
        logger?.warn(
            `[EdgeTTS] response_format="${requestedFormat}" is not returned directly by Edge-TTS; falling back to "mp3".`
        );
    }

    const resolvedVoice = resolveVoice(voice, defaultVoice);
    const rate = resolveRate(speed);
    const escapedText = escapeXml(input);

    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const buffer = await synthesizeOnce(escapedText, resolvedVoice, rate);
            return {
                buffer,
                contentType: "audio/mpeg",
                format: "mp3",
                rate,
                voice: resolvedVoice,
            };
        } catch (error) {
            lastError = error;
            if (attempt < 2) {
                logger?.warn(`[EdgeTTS] Synthesis attempt ${attempt} failed (${error.message}), retrying once...`);
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
    }

    throw lastError;
}

module.exports = {
    escapeXml,
    OPENAI_VOICE_TO_EDGE_MAP,
    resolveRate,
    resolveVoice,
    synthesize,
};
