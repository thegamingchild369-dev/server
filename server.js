import express from "express";
import { createServer } from "http";
import WebSocket, { WebSocketServer } from "ws";
import { randomInt, randomUUID } from "node:crypto";

const app = express();
const server = createServer(app);
const port = process.env.PORT || 10000;

app.get("/", (req, res) => {
    res.send("LabEx Sim multiplayer server");
});

const wss = new WebSocketServer({
    server,
    path: "/ws"
});

const players = new Map();
const rooms = new Map();
const sockets = new Map();

const roomAdjectives = [
    "Amber", "Brisk", "Cosmic", "Daring", "Frosty", "Golden",
    "Hidden", "Jolly", "Lucky", "Misty", "Neon", "Quiet"
];
const roomNouns = [
    "Badger", "Comet", "Dragon", "Falcon", "Harbor", "Island",
    "Jaguar", "Lantern", "Meadow", "Otter", "Panda", "Voyage"
];
const usernameAdjectives = [
    "Amber", "Brisk", "Cosmic", "Daring", "Frosty", "Golden",
    "Hidden", "Jolly", "Lucky", "Misty", "Neon", "Quiet"
];
const usernameNouns = [
    "Badger", "Comet", "Dragon", "Falcon", "Harbor", "Island",
    "Jaguar", "Lantern", "Meadow", "Otter", "Panda", "Voyage"
];
const adminNameCharacters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function createUsername() {
    const taken = new Set(
        Array.from(players.values(), player => player.name.toLowerCase())
            .filter(name => name !== "admin")
    );

    for (let attempt = 0; attempt < 100; attempt += 1) {
        const adjective = usernameAdjectives[Math.floor(Math.random() * usernameAdjectives.length)];
        const noun = usernameNouns[Math.floor(Math.random() * usernameNouns.length)];
        const number = Math.floor(Math.random() * 90) + 10;
        const name = `${adjective}${noun}${number}`;
        if (!taken.has(name.toLowerCase())) {
            return name;
        }
    }

    let name;
    do {
        name = `Guest${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    } while (taken.has(name.toLowerCase()));
    return name;
}

function createAdminUsername(id) {
    const taken = new Set(
        Array.from(players.entries())
            .filter(([playerId]) => playerId !== id)
            .map(([, player]) => player.name.toLowerCase())
    );

    let name;
    do {
        let suffix = "";
        for (let index = 0; index < 4; index += 1) {
            suffix += adminNameCharacters[randomInt(adminNameCharacters.length)];
        }
        name = `admin-${suffix}`;
    } while (taken.has(name.toLowerCase()));
    return name;
}

function send(socket, data) {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(data));
    }
}

function getRoomList() {
    return Array.from(rooms.values())
        .filter(room => !room.started)
        .map(room => ({
            id: room.id,
            name: room.name,
            playerCount: room.players.size
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function getRoomState(room) {
    const roomPlayers = {};
    for (const playerId of room.players) {
        const player = players.get(playerId);
        if (player) {
            roomPlayers[playerId] = {
                name: player.name,
                isHost: playerId === room.hostId
            };
        }
    }

    return {
        id: room.id,
        name: room.name,
        hostId: room.hostId,
        gameMode: room.gameMode,
        started: room.started,
        roles: Object.fromEntries(room.roles || []),
        roundNumber: room.roundNumber || 0,
        phase: room.phase || null,
        phaseEndsAt: room.phaseEndsAt || null,
        endsAt: room.endsAt || null,
        ended: room.ended === true,
        nextRoundAt: room.nextRoundAt || null,
        endReason: room.endReason || null,
        players: roomPlayers
    };
}

function broadcastRoomState(room) {
    const message = {
        type: "room_state",
        room: getRoomState(room)
    };

    for (const playerId of room.players) {
        const socket = sockets.get(playerId);
        if (socket) {
            send(socket, message);
        }
    }
}

function broadcastGameState(room, messageType = "game_state") {
    const state = getRoomState(room);
    for (const playerId of room.players) {
        const socket = sockets.get(playerId);
        if (socket) {
            send(socket, {
                type: messageType,
                room: state,
                role: room.roles?.get(playerId) || null
            });
        }
    }
}

function broadcastRoomList() {
    const message = {
        type: "rooms",
        rooms: getRoomList()
    };

    for (const socket of wss.clients) {
        send(socket, message);
    }
}

function broadcastPlayers(roomId) {
    const room = rooms.get(roomId);
    if (!room) {
        return;
    }

    for (const playerId of room.players) {
        const socket = sockets.get(playerId);
        if (socket) {
            const viewerRole = room.roles?.get(playerId);
            const roomPlayers = {};
            for (const targetId of room.players) {
                const player = players.get(targetId);
                if (!player) {
                    continue;
                }

                const role = room.roles?.get(targetId) || null;
                const hiddenFromViewer = room.gameMode === "hide_and_seek" &&
                    room.started && !room.ended && room.phase === "hiding" &&
                    viewerRole === "hider" && role === "seeker";
                roomPlayers[targetId] = {
                    name: player.name,
                    isAdmin: player.isAdmin,
                    cameraEnabled: player.cameraEnabled,
                    role,
                    hidden: hiddenFromViewer,
                    x: hiddenFromViewer ? null : player.x,
                    y: hiddenFromViewer ? null : player.y,
                    z: hiddenFromViewer ? null : player.z,
                    yaw: player.yaw,
                    emoting: player.emoting,
                    vibrating: player.vibrating
                };
            }

            send(socket, {
                type: "players",
                roomId,
                players: roomPlayers
            });
        }
    }
}

function endGame(room, reason, restartRound = false) {
    if (!room.started || room.ended) {
        return;
    }

    room.ended = true;
    room.phase = "ended";
    room.phaseEndsAt = null;
    room.endReason = reason;
    room.nextRoundAt = restartRound && room.players.size > 1
        ? Date.now() + 5_000
        : null;
    broadcastGameState(room);
    broadcastPlayers(room.id);
}

function startHideAndSeekRound(room, now, rotateSeeker = false) {
    const playerIds = [...room.players];
    if (playerIds.length === 0) {
        return;
    }

    if (rotateSeeker && room.seekerId) {
        const previousSeekerIndex = playerIds.indexOf(room.seekerId);
        room.seekerId = playerIds[
            (previousSeekerIndex + 1 + playerIds.length) % playerIds.length
        ];
    } else if (!room.players.has(room.seekerId)) {
        room.seekerId = room.players.has(room.hostId) ? room.hostId : playerIds[0];
    }

    room.roundNumber = (room.roundNumber || 0) + 1;
    room.roles = new Map(playerIds.map(playerId => [
        playerId,
        playerId === room.seekerId ? "seeker" : "hider"
    ]));
    room.phase = "hiding";
    room.phaseEndsAt = now + 30_000;
    room.endsAt = room.phaseEndsAt + 5 * 60_000;
    room.ended = false;
    room.endReason = null;
    room.nextRoundAt = null;

    for (const playerId of playerIds) {
        const player = players.get(playerId);
        if (player) {
            player.x = 0;
            player.y = 0;
            player.z = 0;
            player.yaw = 0;
            player.emoting = false;
            player.vibrating = false;
        }
    }
}

function advanceHideAndSeek(room, now) {
    if (!room.started || room.gameMode !== "hide_and_seek") {
        return;
    }

    if (room.ended) {
        if (room.nextRoundAt && now >= room.nextRoundAt) {
            if (room.players.size < 2) {
                room.nextRoundAt = null;
                broadcastGameState(room);
                return;
            }
            startHideAndSeekRound(room, now, true);
            broadcastGameState(room);
            broadcastPlayers(room.id);
        }
        return;
    }

    if (room.phase === "hiding" && now >= room.phaseEndsAt) {
        room.phase = "seeking";
        room.phaseEndsAt = room.endsAt;
        broadcastGameState(room);
        broadcastPlayers(room.id);
    }

    if (room.phase !== "seeking") {
        return;
    }

    if (now >= room.endsAt) {
        endGame(room, "Time ran out. The hiders win.", true);
        return;
    }

    const seekers = [];
    const hiders = [];
    for (const playerId of room.players) {
        if (room.roles.get(playerId) === "seeker") {
            seekers.push(playerId);
        } else if (room.roles.get(playerId) === "hider") {
            hiders.push(playerId);
        }
    }

    if (hiders.length === 0) {
        endGame(room, "All hiders were found. The seekers win.", true);
        return;
    }

    const tagDistanceSquared = 3.5 * 3.5;
    let taggedPlayer = null;
    for (const seekerId of seekers) {
        const seeker = players.get(seekerId);
        if (!seeker) {
            continue;
        }

        for (const hiderId of hiders) {
            const hider = players.get(hiderId);
            if (!hider) {
                continue;
            }
            const dx = seeker.x - hider.x;
            const dz = seeker.z - hider.z;
            const dy = seeker.y - hider.y;
            if (dx * dx + dz * dz <= tagDistanceSquared && Math.abs(dy) <= 4) {
                taggedPlayer = hiderId;
                break;
            }
        }
        if (taggedPlayer) {
            break;
        }
    }

    if (taggedPlayer) {
        room.roles.set(taggedPlayer, "seeker");
        broadcastGameState(room);
        broadcastPlayers(room.id);
        if (![...room.roles.values()].includes("hider")) {
            endGame(room, "All hiders were found. The seekers win.", true);
            return;
        }
    }
}

function leaveRoom(id) {
    const player = players.get(id);
    if (!player || !player.roomId) {
        return;
    }

    const roomId = player.roomId;
    const room = rooms.get(roomId);
    player.roomId = null;

    if (room) {
        room.players.delete(id);
        room.roles?.delete(id);
        if (room.players.size === 0) {
            rooms.delete(roomId);
        } else {
            if (room.hostId === id) {
                room.hostId = room.players.values().next().value;
            }
            broadcastPlayers(roomId);
            broadcastRoomState(room);
            if (room.gameMode === "hide_and_seek" && room.started &&
                !room.ended && room.phase === "seeking" &&
                ![...room.roles.values()].includes("hider")) {
                endGame(room, "No hiders remain in the room. The seekers win.", true);
            }
        }
    }

    broadcastRoomList();
}

function joinRoom(id, requestedRoomId) {
    const player = players.get(id);
    const room = rooms.get(requestedRoomId);
    if (!player || !room) {
        send(sockets.get(id), {
            type: "room_error",
            message: "That room is no longer available."
        });
        return;
    }

    if (room.started) {
        send(sockets.get(id), {
            type: "room_error",
            message: "That game has already started."
        });
        return;
    }

    if (player.roomId !== room.id) {
        leaveRoom(id);
    }

    player.x = 0;
    player.y = 0;
    player.z = 0;
    player.yaw = 0;
    player.emoting = false;
    player.vibrating = false;
    player.roomId = room.id;
    room.players.add(id);

    send(sockets.get(id), {
        type: "room_joined",
        room: {
            ...getRoomState(room)
        },
        username: player.name
    });

    broadcastPlayers(room.id);
    broadcastRoomState(room);
    broadcastRoomList();
}

function createRoomName() {
    let name;
    const existingNames = new Set(Array.from(rooms.values(), room => room.name));
    do {
        const adjective = roomAdjectives[Math.floor(Math.random() * roomAdjectives.length)];
        const noun = roomNouns[Math.floor(Math.random() * roomNouns.length)];
        const number = Math.floor(Math.random() * 90) + 10;
        name = `${adjective} ${noun} ${number}`;
    } while (existingNames.has(name));
    return name;
}

wss.on("connection", socket => {
    const id = randomUUID();
    sockets.set(id, socket);
    players.set(id, {
        name: createUsername(),
        isAdmin: false,
        x: 0,
        y: 0,
        z: 0,
        yaw: 0,
        emoting: false,
        vibrating: false,
        cameraEnabled: false,
        roomId: null
    });

    send(socket, {
        type: "welcome",
        id,
        username: players.get(id).name,
        isAdmin: false
    });

    socket.on("message", rawMessage => {
        let data;
        try {
            data = JSON.parse(rawMessage.toString());
        } catch (error) {
            console.error("Invalid message", error);
            return;
        }

        if (!data || typeof data !== "object" || typeof data.type !== "string") {
            return;
        }

        if (data.type === "list_rooms") {
            send(socket, { type: "rooms", rooms: getRoomList() });
            return;
        }

        if (data.type === "create_room") {
            const room = {
                id: randomUUID(),
                name: createRoomName(),
                players: new Set(),
                hostId: id,
                gameMode: "sandbox",
                started: false,
                roles: new Map(),
                phase: null,
                phaseEndsAt: null,
                endsAt: null,
                ended: false,
                roundNumber: 0,
                seekerId: id,
                nextRoundAt: null,
                endReason: null
            };
            rooms.set(room.id, room);
            joinRoom(id, room.id);
            return;
        }

        if (data.type === "join_room" && typeof data.roomId === "string") {
            joinRoom(id, data.roomId);
            return;
        }

        if (data.type === "request_room_state") {
            const player = players.get(id);
            const room = player?.roomId ? rooms.get(player.roomId) : null;
            if (room) {
                send(socket, {
                    type: "room_state",
                    room: getRoomState(room)
                });
            }
            return;
        }

        if (data.type === "set_game_mode" &&
            (data.gameMode === "sandbox" || data.gameMode === "hide_and_seek")) {
            const player = players.get(id);
            const room = player?.roomId ? rooms.get(player.roomId) : null;
            if (!room || room.hostId !== id || room.started) {
                return;
            }

            room.gameMode = data.gameMode;
            broadcastRoomState(room);
            return;
        }

        if (data.type === "start_game") {
            const player = players.get(id);
            const room = player?.roomId ? rooms.get(player.roomId) : null;
            if (!room || room.hostId !== id || room.started) {
                return;
            }

            if (room.gameMode === "hide_and_seek") {
                room.started = true;
                room.seekerId = room.hostId;
                startHideAndSeekRound(room, Date.now());
            } else {
                room.started = true;
                room.phase = "playing";
            }

            broadcastGameState(room, "game_started");
            broadcastPlayers(room.id);
            broadcastRoomState(room);
            broadcastRoomList();
            return;
        }

        if (data.type === "end_game") {
            const player = players.get(id);
            const room = player?.roomId ? rooms.get(player.roomId) : null;
            if (!room || room.hostId !== id || !room.started || room.ended) {
                return;
            }

            endGame(room, "The host ended the game.");
            return;
        }

        if (data.type === "kick_player" && typeof data.targetId === "string") {
            const player = players.get(id);
            const room = player?.roomId ? rooms.get(player.roomId) : null;
            const target = players.get(data.targetId);
            if (!room || room.hostId !== id || data.targetId === id ||
                !target || target.roomId !== room.id) {
                return;
            }

            send(sockets.get(data.targetId), {
                type: "room_kicked",
                message: "You were removed from the room by the host."
            });
            leaveRoom(data.targetId);
            return;
        }

        if (data.type === "become_admin") {
            const player = players.get(id);
            if (player && !player.isAdmin) {
                player.name = createAdminUsername(id);
                player.isAdmin = true;
                send(socket, {
                    type: "identity",
                    username: player.name,
                    isAdmin: true
                });
                if (player.roomId) {
                    broadcastPlayers(player.roomId);
                    const room = rooms.get(player.roomId);
                    if (room) {
                        broadcastRoomState(room);
                    }
                }
            }
            return;
        }

        if (data.type === "camera_enabled" && typeof data.enabled === "boolean") {
            const player = players.get(id);
            if (!player?.isAdmin || !player.roomId) {
                return;
            }

            player.cameraEnabled = data.enabled;
            broadcastPlayers(player.roomId);
            return;
        }

        if (data.type === "camera_signal" &&
            typeof data.targetId === "string" &&
            data.signal &&
            typeof data.signal === "object") {
            const player = players.get(id);
            const target = players.get(data.targetId);
            const signalType = data.signal.type;
            const validDirection = signalType === "offer"
                ? target?.isAdmin === true && target.cameraEnabled
                : signalType === "answer"
                    ? player?.isAdmin === true && player.cameraEnabled
                    : signalType === "candidate" &&
                      ((player?.isAdmin === true && player.cameraEnabled) ||
                       (target?.isAdmin === true && target.cameraEnabled));
            if (!player?.roomId || player.roomId !== target?.roomId ||
                !validDirection ||
                JSON.stringify(data.signal).length > 65536) {
                return;
            }

            send(sockets.get(data.targetId), {
                type: "camera_signal",
                from: id,
                signal: data.signal
            });
            return;
        }

        if (data.type === "admin_chat") {
            const player = players.get(id);
            if (!player?.isAdmin || typeof data.text !== "string") {
                return;
            }

            const text = data.text.trim();
            if (!text || text.length > 500) {
                return;
            }

            const message = {
                type: "admin_chat",
                author: player.name,
                text
            };
            for (const [recipientId, recipient] of players) {
                if (recipient.isAdmin) {
                    const recipientSocket = sockets.get(recipientId);
                    if (recipientSocket) {
                        send(recipientSocket, message);
                    }
                }
            }
            return;
        }

        if (data.type === "position") {
            const player = players.get(id);
            if (!player || !player.roomId) {
                return;
            }

            const x = Number(data.x);
            const y = Number(data.y);
            const z = Number(data.z);
            const yaw = Number(data.yaw);

            if (![x, y, z, yaw].every(Number.isFinite)) {
                return;
            }

            if (player.roomId) {
                const room = rooms.get(player.roomId);
                if (room?.gameMode === "hide_and_seek" && room.started &&
                    !room.ended && room.phase === "hiding" &&
                    room.roles.get(id) === "seeker") {
                    return;
                }
            }
            player.x = x;
            player.y = y;
            player.z = z;
            player.yaw = yaw;
            return;
        }

        if (data.type === "emote" &&
            typeof data.emoting === "boolean" &&
            typeof data.vibrating === "boolean") {
            const player = players.get(id);
            if (!player || !player.roomId) {
                return;
            }

            player.emoting = data.emoting;
            player.vibrating = data.emoting && data.vibrating;
            broadcastPlayers(player.roomId);
        }
    });

    socket.on("close", () => {
        leaveRoom(id);
        players.delete(id);
        sockets.delete(id);
    });
});

setInterval(() => {
    const now = Date.now();
    for (const [roomId, room] of rooms) {
        advanceHideAndSeek(room, now);
        broadcastPlayers(roomId);
    }
}, 50);

server.listen(port, "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
});
