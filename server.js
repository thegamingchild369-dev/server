import express from "express";
import { createServer } from "http";
import WebSocket, { WebSocketServer } from "ws";


// --------------------------------------------------
// HTTP SERVER
// --------------------------------------------------

const app = express();

const server = createServer(app);

const port =
    process.env.PORT || 10000;


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

    const id =
        crypto.randomUUID();


    players.set(id, {
        name: "Player",
        x: 0,
        y: 1.5,
        z: 0
    });


    console.log(
        "Player connected:",
        id
    );


    // Send ID

    socket.send(
        JSON.stringify({

            type: "welcome",

            id

        })
    );


    // ------------------------------------------------
    // RECEIVE DATA
    // ------------------------------------------------

    socket.on("message", message => {

        if (data.type === "join") {
            const player = players.get(id);
            if (player && typeof data.name === "string") {
                player.name = data.name.trim().slice(0, 16) || "Player";
             }
        }
        try {

            const data =
                JSON.parse(message);


            if (
                data.type === "position"
            ) {

                const player =
                    players.get(id);


                if (!player) {
                    return;
                }


                player.x =
                    Number(data.x);

                player.y =
                    Number(data.y);

                player.z =
                    Number(data.z);
            }

        }

        catch (error) {

            console.error(
                "Invalid message"
            );

        }

    });


    // ------------------------------------------------
    // DISCONNECT
    // ------------------------------------------------

    socket.on("close", () => {

        players.delete(id);

        console.log(
            "Player disconnected:",
            id
        );

    });

});


// --------------------------------------------------
// BROADCAST POSITIONS
// --------------------------------------------------

setInterval(() => {

    const playerList =
        Object.fromEntries(players);


    const message =
        JSON.stringify({

            type: "players",

            players: playerList

        });


    wss.clients.forEach(socket => {

        if (
            socket.readyState ===
            WebSocket.OPEN
        ) {

            socket.send(message);

        }

    });

}, 50);


// --------------------------------------------------
// START
// --------------------------------------------------

server.listen(
    port,
    "0.0.0.0",
    () => {

        console.log(
            `Server running on port ${port}`
        );

    }
);
