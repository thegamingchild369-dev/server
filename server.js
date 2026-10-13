import express from "express";
import { createServer } from "http";
import WebSocket, { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

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

function send(socket, data) {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(data));
    }
}

function getRoomList() {
    return Array.from(rooms.values(), room => ({
        id: room.id,
        name: room.name,
        playerCount: room.players.size
    })).sort((a, b) => a.name.localeCompare(b.name));
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

    const roomPlayers = {};
    for (const playerId of room.players) {
        const player = players.get(playerId);
        if (player) {
            roomPlayers[playerId] = {
                name: player.name,
                x: player.x,
                y: player.y,
                z: player.z,
                yaw: player.yaw
            };
        }
    }

    const message = {
        type: "players",
        roomId,
        players: roomPlayers
    };

    for (const playerId of room.players) {
        const socket = sockets.get(playerId);
        if (socket) {
            send(socket, message);
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
        if (room.players.size === 0) {
            rooms.delete(roomId);
        } else {
            broadcastPlayers(roomId);
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

    if (player.roomId !== room.id) {
        leaveRoom(id);
    }

    player.x = 0;
    player.y = 3.5;
    player.z = 0;
    player.yaw = 0;
    player.roomId = room.id;
    room.players.add(id);

    send(sockets.get(id), {
        type: "room_joined",
        room: {
            id: room.id,
            name: room.name
        },
        username: player.name
    });

    broadcastPlayers(room.id);
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
        x: 0,
        y: 3.5,
        z: 0,
        yaw: 0,
        roomId: null
    });

    send(socket, {
        type: "welcome",
        id,
        username: players.get(id).name
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
                players: new Set()
            };
            rooms.set(room.id, room);
            joinRoom(id, room.id);
            return;
        }

        if (data.type === "join_room" && typeof data.roomId === "string") {
            joinRoom(id, data.roomId);
            return;
        }

        if (data.type === "become_admin") {
            const player = players.get(id);
            if (player) {
                player.name = "admin";
                send(socket, { type: "identity", username: player.name });
                if (player.roomId) {
                    broadcastPlayers(player.roomId);
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

            player.x = x;
            player.y = y;
            player.z = z;
            player.yaw = yaw;
        }
    });

    socket.on("close", () => {
        leaveRoom(id);
        players.delete(id);
        sockets.delete(id);
    });
});

setInterval(() => {
    for (const roomId of rooms.keys()) {
        broadcastPlayers(roomId);
    }
}, 50);

server.listen(port, "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
});
