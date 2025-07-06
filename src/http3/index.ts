import { readFile, open, FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Http3Server } from '@fails-components/webtransport';
import { fileURLToPath } from 'node:url';

const PORT = 4433;
const CHUNK_SIZE = 64 * 1024; // 64 KB
const INTERVAL_MS = 2000; // 2 seconds per chunk

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const certPath = path.resolve(__dirname, './certs/server.crt');
const keyPath = path.resolve(__dirname, './certs/server.key');
const audioPath = path.resolve(__dirname, './data/uploads/radio-los-santos.mp3');

// Store active sessions and their streams
const activeSessions = new Map<any, Set<any>>();
let isServerRunning = false;
let broadcastInterval: NodeJS.Timeout | null = null;
let fileHandle: FileHandle | null = null;

export async function startHttp3Server(): Promise<void> {
    const cert = await readFile(certPath, 'utf8');
    const privKey = await readFile(keyPath, 'utf8');

    const server = new Http3Server({
        host: '0.0.0.0',
        port: PORT,
        cert,
        privKey,
        secret: 'radio-secret',
    });

    server.startServer();
    isServerRunning = true;
    console.log(`✅ HTTP/3 server listening on https://localhost:${PORT}`);

    // Open audio file once
    fileHandle = await open(audioPath, 'r');

    let isKilled = false;

    function handleShutdown(signal: string): void {
        console.log(`\n🛑 Received ${signal}, shutting down server...`);
        isKilled = true;
        isServerRunning = false;
        stopBroadcast();
        server.stopServer();
        if (fileHandle) {
            fileHandle.close();
        }
        process.exit(0);
    }

    process.on("SIGINT", () => handleShutdown("SIGINT"));
    process.on("SIGTERM", () => handleShutdown("SIGTERM"));

    try {
        // Use the sessionStream approach from your example
        const sessionStream = server.sessionStream("/");
        const sessionReader = sessionStream.getReader();

        console.log({session: sessionReader ? 'Yes' : 'No'});

        sessionReader.closed.catch((e: any) => {
            console.log("Session reader closed with error!", e);
        });

        // Start broadcasting in parallel
        if(activeSessions.size !== 0) {
            console.log(activeSessions);
            startAudioBroadcast();
        }

        while (!isKilled) {
            console.log("Waiting for new session...");
            const { done, value: session } = await sessionReader.read();

            if (done) {
                console.log("Session reader done, breaking loop");
                break;
            }

            console.log("[+] New client session established");

            // Initialize session in our tracking
            activeSessions.set(session, new Set());

            session.closed.then(() => {
                console.log("[-] Session closed successfully");
                activeSessions.delete(session);
            }).catch((e: any) => {
                console.log("[-] Session closed with error:", e);
                activeSessions.delete(session);
            });

            session.ready.then(() => {
                console.log("[+] Session ready");

                // Create bidirectional stream for this session
                session.createBidirectionalStream().then((stream: any) => {
                    console.log("[+] Bidirectional stream created");

                    // Add stream to session's stream set
                    const sessionStreams = activeSessions.get(session);
                    if (sessionStreams) {
                        sessionStreams.add(stream);
                    }

                    const reader = stream.readable.getReader();
                    reader.closed.catch((e: any) => {
                        console.log("Stream reader closed with error:", e);
                        // Remove stream from session
                        const sessionStreams = activeSessions.get(session);
                        if (sessionStreams) {
                            sessionStreams.delete(stream);
                        }
                    });

                    const writer = stream.writable.getWriter();
                    writer.closed.catch((e: any) => {
                        console.log("Stream writer closed with error:", e);
                        // Remove stream from session
                        const sessionStreams = activeSessions.get(session);
                        if (sessionStreams) {
                            sessionStreams.delete(stream);
                        }
                    });

                }).catch((e: any) => {
                    console.log("Failed to create bidirectional stream:", e);
                });

            }).catch((e: any) => {
                console.log("Session failed to be ready:", e);
                activeSessions.delete(session);
            });
        }

    } catch (e) {
        console.error("Error in session management:", e);
    }
}

function startAudioBroadcast(): void {
    console.log('🎵 Starting audio broadcast...');

    let position = 0;

    broadcastInterval = setInterval(async () => {
        if (!isServerRunning || !fileHandle) return;

        try {
            const buffer = Buffer.alloc(CHUNK_SIZE);
            const { bytesRead } = await fileHandle.read(buffer, 0, CHUNK_SIZE, position);

            if (bytesRead === 0) {
                console.log('🔁 Restarting audio file...');
                position = 0;
                return;
            }

            const chunk = buffer.slice(0, bytesRead);
            position += bytesRead;

            // Broadcast to all active sessions
            await broadcastChunk(chunk);

            console.log(`📡 Broadcasted ${bytesRead} bytes to ${activeSessions.size} sessions`);

        } catch (err) {
            console.error('❌ Error reading audio file:', err);
        }
    }, INTERVAL_MS);
}

async function broadcastChunk(chunk: Buffer): Promise<void> {
    const timestamp = Date.now();
    const sessionsToRemove: any[] = [];

    for (const [session, streams] of activeSessions.entries()) {
        try {
            // Check if session is still alive
            if (session.closed) {
                sessionsToRemove.push(session);
                continue;
            }

            const streamsToRemove: any[] = [];

            for (const stream of streams) {
                try {
                    // Create a packet with timestamp for synchronization
                    const packet = createSyncPacket(chunk, timestamp);

                    const writer = stream.writable.getWriter();
                    await writer.write(packet);
                    writer.releaseLock();

                } catch (streamErr: any) {
                    console.warn('⚠️ Failed to write to stream:', streamErr.message);
                    streamsToRemove.push(stream);
                }
            }

            // Remove failed streams
            for (const stream of streamsToRemove) {
                streams.delete(stream);
            }

        } catch (sessionErr: any) {
            console.warn('⚠️ Session error:', sessionErr.message);
            sessionsToRemove.push(session);
        }
    }

    // Remove failed sessions
    for (const session of sessionsToRemove) {
        activeSessions.delete(session);
    }
}

function createSyncPacket(audioChunk: Buffer, timestamp: number): Uint8Array {
    // Create a packet with timestamp for client synchronization
    const timestampBuffer = Buffer.alloc(8);
    timestampBuffer.writeBigUInt64BE(BigInt(timestamp), 0);

    const chunkSizeBuffer = Buffer.alloc(4);
    chunkSizeBuffer.writeUInt32BE(audioChunk.length, 0);

    return new Uint8Array(Buffer.concat([timestampBuffer, chunkSizeBuffer, audioChunk]));
}

function stopBroadcast(): void {
    isServerRunning = false;
    if (broadcastInterval) {
        clearInterval(broadcastInterval);
        broadcastInterval = null;
    }
    console.log('🛑 Audio broadcast stopped');
}
