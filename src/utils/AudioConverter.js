/**
 * File: src/utils/AudioConverter.js
 * Description: Audio format parsing and conversion helpers for TTS (PCM / WAV / MP3)
 */

const SUPPORTED_AUDIO_FORMATS = new Set(["mp3", "pcm", "wav"]);

let cachedLameModulePromise = null;

/**
 * Dynamically load @breezystack/lamejs (its package.json CJS entry points to an IIFE script,
 * so standard ESM dynamic import is required in Node.js).
 * @returns {Promise<Function>} Mp3Encoder constructor
 */
async function getMp3Encoder() {
    if (!cachedLameModulePromise) {
        cachedLameModulePromise = import("@breezystack/lamejs").catch(error => {
            cachedLameModulePromise = null;
            throw error;
        });
    }

    const lameModule = await cachedLameModulePromise;
    const Mp3Encoder = lameModule.Mp3Encoder || lameModule.default?.Mp3Encoder;
    if (typeof Mp3Encoder !== "function") {
        throw new Error("Failed to load Mp3Encoder from @breezystack/lamejs.");
    }

    return Mp3Encoder;
}

/**
 * Parse sample rate, channels, and base MIME type from Gemini inlineData mimeType.
 * Example: "audio/L16;codec=pcm;rate=24000"
 * @param {string} mimeType
 * @returns {{ baseType: string, bitsPerSample: number, channels: number, sampleRate: number }}
 */
function parseAudioMimeType(mimeType = "audio/L16;codec=pcm;rate=24000") {
    const normalized = typeof mimeType === "string" && mimeType.trim() ? mimeType.trim() : "audio/L16;rate=24000";
    const [rawBaseType] = normalized.split(";");
    const baseType = rawBaseType.trim().toLowerCase();

    const rateMatch = normalized.match(/rate=(\d+)/i);
    const parsedRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
    const sampleRate = Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : 24000;

    const channelsMatch = normalized.match(/channels=(\d+)/i);
    const parsedChannels = channelsMatch ? parseInt(channelsMatch[1], 10) : 1;
    const channels = parsedChannels === 2 ? 2 : 1;

    return {
        baseType,
        bitsPerSample: 16,
        channels,
        sampleRate,
    };
}

/**
 * Extract raw PCM buffer and audio metadata from a RIFF/WAVE buffer.
 * Returns null if the buffer is not a valid WAV container.
 * @param {Buffer} wavBuffer
 * @returns {{ bitsPerSample: number, channels: number, pcmBuffer: Buffer, sampleRate: number } | null}
 */
function extractPcmFromWav(wavBuffer) {
    if (!Buffer.isBuffer(wavBuffer) || wavBuffer.length < 44) {
        return null;
    }

    if (wavBuffer.toString("ascii", 0, 4) !== "RIFF" || wavBuffer.toString("ascii", 8, 12) !== "WAVE") {
        return null;
    }

    let bitsPerSample = 16;
    let channels = 1;
    let pcmBuffer = null;
    let sampleRate = 24000;
    let offset = 12;

    while (offset + 8 <= wavBuffer.length) {
        const chunkId = wavBuffer.toString("ascii", offset, offset + 4);
        const chunkSize = wavBuffer.readUInt32LE(offset + 4);
        const dataStart = offset + 8;
        const dataEnd = Math.min(dataStart + chunkSize, wavBuffer.length);

        if (chunkId === "fmt " && dataEnd - dataStart >= 16) {
            channels = wavBuffer.readUInt16LE(dataStart + 2) === 2 ? 2 : 1;
            const parsedRate = wavBuffer.readUInt32LE(dataStart + 4);
            if (parsedRate > 0) {
                sampleRate = parsedRate;
            }
            const parsedBits = wavBuffer.readUInt16LE(dataStart + 14);
            if (parsedBits > 0) {
                bitsPerSample = parsedBits;
            }
        } else if (chunkId === "data") {
            pcmBuffer = wavBuffer.subarray(dataStart, dataEnd);
            break;
        }

        // RIFF chunks are word-aligned (padded to even byte boundary)
        offset = dataStart + chunkSize + (chunkSize % 2);
    }

    if (!pcmBuffer) {
        return null;
    }

    return {
        bitsPerSample,
        channels,
        pcmBuffer,
        sampleRate,
    };
}

/**
 * Prepend a standard 44-byte RIFF/WAVE header to raw little-endian PCM bytes.
 * @param {Buffer} pcmBuffer
 * @param {object} [options]
 * @returns {Buffer}
 */
function createWavBuffer(pcmBuffer, options = {}) {
    const bitsPerSample = options.bitsPerSample || 16;
    const channels = options.channels === 2 ? 2 : 1;
    const sampleRate = options.sampleRate || 24000;

    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = channels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = pcmBuffer.length;

    const header = Buffer.alloc(44);
    header.write("RIFF", 0, 4, "ascii");
    header.writeUInt32LE(36 + dataSize, 4);
    header.write("WAVE", 8, 4, "ascii");
    header.write("fmt ", 12, 4, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write("data", 36, 4, "ascii");
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmBuffer]);
}

/**
 * Encode raw 16-bit signed little-endian PCM bytes into an MP3 Buffer.
 * Copies samples via readInt16LE to avoid Int16Array byteOffset alignment pitfalls.
 * @param {Buffer} pcmBuffer
 * @param {object} [options]
 * @returns {Promise<Buffer>}
 */
async function encodePcmToMp3(pcmBuffer, options = {}) {
    const channels = options.channels === 2 ? 2 : 1;
    const sampleRate = Number.isFinite(options.sampleRate) && options.sampleRate > 0 ? options.sampleRate : 24000;
    const kbps = Number.isFinite(options.kbps) && options.kbps > 0 ? options.kbps : 128;

    const alignedLength = pcmBuffer.length - (pcmBuffer.length % 2);
    const totalSamples = alignedLength / 2;
    if (totalSamples === 0) {
        return Buffer.alloc(0);
    }

    const Mp3Encoder = await getMp3Encoder();
    const encoder = new Mp3Encoder(channels, sampleRate, kbps);
    const sampleBlockSize = 1152;
    const mp3Chunks = [];

    if (channels === 1) {
        const samples = new Int16Array(totalSamples);
        for (let i = 0; i < totalSamples; i++) {
            samples[i] = pcmBuffer.readInt16LE(i * 2);
        }

        for (let i = 0; i < samples.length; i += sampleBlockSize) {
            const chunk = samples.subarray(i, i + sampleBlockSize);
            const encoded = encoder.encodeBuffer(chunk);
            if (encoded.length > 0) {
                mp3Chunks.push(Buffer.from(encoded));
            }
        }
    } else {
        const frames = Math.floor(totalSamples / 2);
        const leftChannel = new Int16Array(frames);
        const rightChannel = new Int16Array(frames);

        for (let i = 0; i < frames; i++) {
            leftChannel[i] = pcmBuffer.readInt16LE(i * 4);
            rightChannel[i] = pcmBuffer.readInt16LE(i * 4 + 2);
        }

        for (let i = 0; i < frames; i += sampleBlockSize) {
            const leftChunk = leftChannel.subarray(i, i + sampleBlockSize);
            const rightChunk = rightChannel.subarray(i, i + sampleBlockSize);
            const encoded = encoder.encodeBuffer(leftChunk, rightChunk);
            if (encoded.length > 0) {
                mp3Chunks.push(Buffer.from(encoded));
            }
        }
    }

    const flushChunk = encoder.flush();
    if (flushChunk.length > 0) {
        mp3Chunks.push(Buffer.from(flushChunk));
    }

    return Buffer.concat(mp3Chunks);
}

/**
 * Convert Gemini inlineData audio part(s) into the requested OpenAI response_format binary buffer.
 * Unsupported formats (e.g., opus, aac, flac) automatically fall back to mp3 for client compatibility.
 * @param {Array<{ data: string, mimeType?: string }>} audioParts
 * @param {string} [requestedFormat="mp3"]
 * @param {object} [logger=null]
 * @returns {Promise<{ buffer: Buffer, contentType: string, format: string }>}
 */
async function convertAudioParts(audioParts, requestedFormat = "mp3", logger = null) {
    const normalizedRequest = typeof requestedFormat === "string" ? requestedFormat.trim().toLowerCase() : "mp3";
    let effectiveFormat = normalizedRequest || "mp3";

    if (!SUPPORTED_AUDIO_FORMATS.has(effectiveFormat)) {
        logger?.warn(`[AudioConverter] Unsupported TTS response_format "${normalizedRequest}", falling back to "mp3".`);
        effectiveFormat = "mp3";
    }

    if (audioParts.length === 1) {
        const singleMeta = parseAudioMimeType(audioParts[0].mimeType);
        if (
            (singleMeta.baseType === "audio/mpeg" || singleMeta.baseType === "audio/mp3") &&
            effectiveFormat === "mp3"
        ) {
            return {
                buffer: Buffer.from(audioParts[0].data, "base64"),
                contentType: "audio/mpeg",
                format: "mp3",
            };
        }
    }

    let audioMeta = null;
    const pcmChunks = [];

    for (const part of audioParts) {
        const rawBuffer = Buffer.from(part.data, "base64");
        const wavExtracted = extractPcmFromWav(rawBuffer);

        if (wavExtracted) {
            if (!audioMeta) {
                audioMeta = {
                    bitsPerSample: wavExtracted.bitsPerSample,
                    channels: wavExtracted.channels,
                    sampleRate: wavExtracted.sampleRate,
                };
            }
            pcmChunks.push(wavExtracted.pcmBuffer);
        } else {
            if (!audioMeta) {
                const parsed = parseAudioMimeType(part.mimeType);
                audioMeta = {
                    bitsPerSample: parsed.bitsPerSample,
                    channels: parsed.channels,
                    sampleRate: parsed.sampleRate,
                };
            }
            pcmChunks.push(rawBuffer);
        }
    }

    const combinedPcm = Buffer.concat(pcmChunks);
    const meta = audioMeta || { bitsPerSample: 16, channels: 1, sampleRate: 24000 };

    if (effectiveFormat === "pcm") {
        return {
            buffer: combinedPcm,
            contentType: "audio/pcm",
            format: "pcm",
        };
    }

    if (effectiveFormat === "wav") {
        return {
            buffer: createWavBuffer(combinedPcm, meta),
            contentType: "audio/wav",
            format: "wav",
        };
    }

    const mp3Buffer = await encodePcmToMp3(combinedPcm, meta);
    return {
        buffer: mp3Buffer,
        contentType: "audio/mpeg",
        format: "mp3",
    };
}

module.exports = {
    convertAudioParts,
    createWavBuffer,
    encodePcmToMp3,
    extractPcmFromWav,
    parseAudioMimeType,
};
