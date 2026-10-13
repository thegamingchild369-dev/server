import express from "express";
import { createServer } from "http";
import WebSocket, { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

// --------------------------------------------------
// HTTP SERVER
// --------------------------------------------------

const app = express();

const server = createServer(app);

const port = process.env.PORT || 10000;

app.get("/", (req, res) => {
    res.send("LabEx Sim multiplayer server");
});

// --------------------------------------------------
// WEBSOCKET SERVER
// --------------------------------------------------

const wss = new WebSocketServer({
    server,
    path: "/ws"
});

// Player storage
const players = new Map();

// --------------------------------------------------
// PLAYER CONNECT
// --------------------------------------------------

wss.on("connection", socket => {
    const id = randomUUID();

    players.set(id, {
        name: "Player",
        x: 0,
        y: 1.5,
        z: 0,
        yaw: 0
    });

    console.log("Player connected:", id);

    // Send ID
    socket.send(JSON.stringify({
        type: "welcome",
        id
    }));

    // ------------------------------------------------
    // RECEIVE DATA
    // ------------------------------------------------

    socket.on("message", rawMessage => {
        let data;

        try {
            data = JSON.parse(rawMessage.toString());
        } catch (error) {
            console.error("Invalid message", error);
            return;
        }

        if (data.type === "join") {
            const player = players.get(id);

            if (player && typeof data.name === "string") {
                player.name = data.name.trim().slice(0, 16) || "Player";
            }

            return;
        }

        if (data.type === "position") {
            const player = players.get(id);

            if (!player) {
                return;
            }

            const x = Number(data.x);
            const y = Number(data.y);
            const z = Number(data.z);

            if (![x, y, z].every(Number.isFinite)) {
                return;
            }

            player.x = x;
            player.y = y;
            player.z = z;

            const yaw = Number(data.yaw);
            if (Number.isFinite(yaw)) {
                player.yaw = yaw;
            }
        }
    });

    // ------------------------------------------------
    // DISCONNECT
    // ------------------------------------------------

    socket.on("close", () => {
        players.delete(id);

        console.log("Player disconnected:", id);
    });
});

// --------------------------------------------------
// BROADCAST POSITIONS
// --------------------------------------------------

setInterval(() => {
    const playerList = Object.fromEntries(players);

    const message = JSON.stringify({
        type: "players",
        players: playerList
    });

    wss.clients.forEach(socket => {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(message);
        }
    });
}, 50);

// --------------------------------------------------
// START
// --------------------------------------------------

server.listen(port, "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
});
