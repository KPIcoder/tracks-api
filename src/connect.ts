import type {ConnectRouter} from "@connectrpc/connect";
import {GenreService} from "../gen/app/genres/v1/genres_pb";
import {TrackService} from "../gen/app/tracks/v1/tracks_pb";
import {
    deleteTrack,
    getGenres as getGenresDb,
    getTrackBySlug,
    getTracks,
    updateTrack,
    deleteMultipleTracks,
    saveAudioFile, getTrackById
} from "./utils/db";
import path from "path";
import config from "./config";
import fs from "fs";

export const genreRouter = (router: ConnectRouter) => router.service(
    GenreService, {
        async getGenres() {
            return {
                genres: await getGenresDb()
            }
        }
    });

export const trackRouter = (router: ConnectRouter) => router.service(
    TrackService, {
        async listTracks(req) {
            const {tracks, total} = await getTracks({
                page: req.page,
                search: req.search,
                limit: req.limit,
                order: req.order as 'asc' | 'desc',
                sort: req.sort as 'title' | 'artist' | 'album' | 'createdAt',
                genre: req.genre,
                artist: req.artist
            })
            const limit = req.limit || 10;
            const page = req.page || 1;
            return {
                data: tracks,
                meta: {
                    limit,
                    page,
                    total,
                    totalPages: Math.ceil(total / limit)
                }

            }
        },

        async getTrack(req) {
            return {
                track: (await getTrackBySlug(req.slug))!
            }
        },

        async updateTrack(req) {
            return {
                track: (await updateTrack(req.id, req))!
            }
        },

        async deleteTrack(req) {
            return {
                success: await deleteTrack(req.id)
            }
        },

        async deleteTracks(req) {
            const {success, failed} = await deleteMultipleTracks(req.ids)

            return {
                success,
                failed
            }
        },

        async uploadTrackFile(req) {
            console.dir({id: req.id, name: req.fileName, bytes: req.chunk.byteLength})
            const file = Buffer.from(req.chunk)
            const path = await saveAudioFile(req.id, req.fileName, file)
            const track = (await updateTrack(req.id, {audioFile: path}))!

            return {
                track
            }
        },

        async *streamTrackAudio(req) {
            const track = await getTrackById(req.trackId)
            if(!track || !track.audioFile) console.error(`Audio is not found for track ${req.trackId}`)
            const filePath = path.join(config.storage.uploadsDir, track!.audioFile!)
            const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 })

            for await (const chunk of stream) {
                yield { chunk }
            }
        }
    }
)
