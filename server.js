"use strict";

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();

const server = http.createServer(app);

const io = new Server(server, {
    maxHttpBufferSize: 1024 * 1024,

    pingInterval: 25000,
    pingTimeout: 20000,

    transports: ["websocket", "polling"],

    cors: {
        origin: true,
        credentials: true
    }
});

app.disable("x-powered-by");

app.use(
    express.json({
        limit: "64kb"
    })
);

app.use(
    express.static(
        path.join(__dirname, "public")
    )
);

app.get("/", (req, res) => {

    res.sendFile(
        path.join(
            __dirname,
            "public",
            "index.html"
        )
    );
});

/* =========================================================
   CONFIG
========================================================= */

const PORT =
    Number(process.env.PORT) || 3000;

const ROOM_PASSWORD =
    process.env.ROOM_PASSWORD || "123456";

if(ROOM_PASSWORD === "123456"){

    console.warn(
        "\n[WAFFLE] UYARI: ROOM_PASSWORD ayarlanmamış."
    );

    console.warn(
        "[WAFFLE] Varsayılan şifre 123456 kullanılıyor.\n"
    );
}

/*
 * TURN desteği:
 *
 * Örnek:
 *
 * TURN_URL=turn:example.com:3478
 * TURN_USERNAME=waffle
 * TURN_CREDENTIAL=secret
 *
 * Birden fazla TURN URL'si virgülle ayrılabilir.
 */

function getIceServers(){

    const servers = [
        {
            urls: [
                "stun:stun.l.google.com:19302"
            ]
        },

        {
            urls: [
                "stun:stun1.l.google.com:19302"
            ]
        },

        {
            urls: [
                "stun:stun.cloudflare.com:3478"
            ]
        }
    ];

    const turnUrl =
        process.env.TURN_URL;

    const turnUsername =
        process.env.TURN_USERNAME;

    const turnCredential =
        process.env.TURN_CREDENTIAL;

    if(
        turnUrl &&
        turnUsername &&
        turnCredential
    ){

        const urls =
            turnUrl
                .split(",")
                .map(x => x.trim())
                .filter(Boolean);

        if(urls.length){

            servers.push({
                urls,
                username: turnUsername,
                credential: turnCredential
            });
        }
    }

    return servers;
}

/* =========================================================
   STATIC CONFIG ENDPOINT
========================================================= */

app.get("/api/rtc-config", (req, res) => {

    res.json({
        iceServers: getIceServers()
    });
});

/* =========================================================
   ROOMS
========================================================= */

const TEXT_ROOMS =
    new Set([
        "Genel",
        "Oyun",
        "Müzik"
    ]);

const VOICE_ROOMS =
    new Set([
        "Sesli - Genel",
        "Sesli - Oyun"
    ]);

const COLORS =
    new Set([
        "#7657ff",
        "#24d6a2",
        "#4d9cff",
        "#ff5870",
        "#f2bd55",
        "#ec72d8",
        "#36c6dc"
    ]);

/* =========================================================
   STATE
========================================================= */

const users =
    new Map();

const voiceChannels = {
    "Sesli - Genel": [],
    "Sesli - Oyun": []
};

const messageHistory = {
    "Genel": [],
    "Oyun": [],
    "Müzik": []
};

/* =========================================================
   LIMITS
========================================================= */

const messageRate =
    new Map();

const typingRate =
    new Map();

const signalRate =
    new Map();

function rateLimited(
    map,
    id,
    limit,
    windowMs
){

    const now =
        Date.now();

    const old =
        map.get(id);

    if(
        !old ||
        now - old.startedAt >= windowMs
    ){

        map.set(id,{
            startedAt:now,
            count:1
        });

        return false;
    }

    old.count++;

    return old.count > limit;
}

/* =========================================================
   SANITIZATION
========================================================= */

function cleanText(
    value,
    max
){

    if(typeof value !== "string"){
        return "";
    }

    return value
        .replace(
            /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
            ""
        )
        .trim()
        .slice(0,max);
}

function cleanUsername(value){

    return cleanText(
        value,
        24
    ).replace(
        /\s+/g,
        " "
    );
}

function validColor(color){

    if(COLORS.has(color)){
        return color;
    }

    return "#7657ff";
}

function allowedTextRoom(room){

    return TEXT_ROOMS.has(room);
}

function allowedVoiceRoom(room){

    return VOICE_ROOMS.has(room);
}

function time(){

    return new Date()
        .toLocaleTimeString(
            "tr-TR",
            {
                hour:"2-digit",
                minute:"2-digit"
            }
        );
}

/* =========================================================
   HISTORY
========================================================= */

function pushHistory(
    room,
    message
){

    if(!messageHistory[room]){
        messageHistory[room] = [];
    }

    messageHistory[room].push(message);

    if(
        messageHistory[room].length >
        100
    ){

        messageHistory[room]
            .splice(
                0,
                messageHistory[room].length - 100
            );
    }
}

/* =========================================================
   USER LIST
========================================================= */

function broadcastUsers(){

    io.emit(
        "updateUserList",
        Array.from(
            users.values()
        ).map(user => ({
            id:user.id,
            username:user.username,
            color:user.color,
            room:user.room,
            voiceChannel:user.voiceChannel
        }))
    );
}

/* =========================================================
   VOICE STATE
========================================================= */

function broadcastVoiceState(){

    io.emit(
        "updateVoiceState",
        voiceChannels
    );
}

/* =========================================================
   REMOVE FROM VOICE
========================================================= */

function removeFromVoice(
    socket,
    notify = true
){

    const user =
        users.get(socket.id);

    if(!user) return;

    const channel =
        user.voiceChannel;

    if(!channel) return;

    if(
        Array.isArray(
            voiceChannels[channel]
        )
    ){

        voiceChannels[channel] =
            voiceChannels[channel]
                .filter(
                    member =>
                        member.id !== socket.id
                );
    }

    socket.leave(channel);

    if(notify){

        socket.to(channel).emit(
            "userLeftVoice",
            socket.id
        );

        socket.to(channel).emit(
            "userStoppedScreenShare",
            socket.id
        );
    }

    user.voiceChannel = null;

    broadcastVoiceState();
    broadcastUsers();
}

/* =========================================================
   SOCKET CONNECTION
========================================================= */

io.on("connection", socket => {

    console.log(
        `[CONNECT] ${socket.id}`
    );

    /* =====================================================
       LOGIN
    ===================================================== */

    socket.on(
        "joinRoom",
        payload => {

            if(users.has(socket.id)){
                return;
            }

            const username =
                cleanUsername(
                    payload?.username
                );

            const password =
                typeof payload?.password === "string"
                    ? payload.password
                    : "";

            const room =
                payload?.room;

            const color =
                validColor(
                    payload?.color
                );

            if(password !== ROOM_PASSWORD){

                socket.emit(
                    "loginError",
                    "Hatalı sunucu şifresi."
                );

                return;
            }

            if(
                username.length < 2 ||
                username.length > 24
            ){

                socket.emit(
                    "loginError",
                    "Kullanıcı adı 2-24 karakter olmalı."
                );

                return;
            }

            if(
                !allowedTextRoom(room)
            ){

                socket.emit(
                    "loginError",
                    "Geçersiz sohbet odası."
                );

                return;
            }

            const duplicate =
                Array.from(
                    users.values()
                ).some(
                    user =>
                        user.username
                            .toLowerCase() ===
                        username.toLowerCase()
                );

            if(duplicate){

                socket.emit(
                    "loginError",
                    "Bu kullanıcı adı zaten kullanımda."
                );

                return;
            }

            const user = {
                id:socket.id,
                username,
                color,
                room,
                voiceChannel:null
            };

            users.set(
                socket.id,
                user
            );

            socket.join(room);

            socket.emit(
                "loginSuccess"
            );

            socket.emit(
                "chatHistory",
                messageHistory[room] || []
            );

            broadcastUsers();
            broadcastVoiceState();

            const joinMessage = {
                user:"Sistem",
                text:`${username} katıldı.`,
                time:time(),
                color:"#7f8a9a"
            };

            socket.to(room).emit(
                "message",
                joinMessage
            );
        }
    );

    /* =====================================================
       ROOM SWITCH
    ===================================================== */

    socket.on(
        "switchRoom",
        newRoom => {

            const user =
                users.get(socket.id);

            if(!user) return;

            if(
                !allowedTextRoom(newRoom)
            ){
                return;
            }

            if(
                newRoom === user.room
            ){
                socket.emit(
                    "chatHistory",
                    messageHistory[newRoom] || []
                );

                return;
            }

            const oldRoom =
                user.room;

            socket.leave(oldRoom);

            socket.to(oldRoom).emit(
                "message",
                {
                    user:"Sistem",
                    text:`${user.username} odadan ayrıldı.`,
                    time:time(),
                    color:"#7f8a9a"
                }
            );

            user.room =
                newRoom;

            socket.join(newRoom);

            socket.emit(
                "chatHistory",
                messageHistory[newRoom] || []
            );

            socket.to(newRoom).emit(
                "message",
                {
                    user:"Sistem",
                    text:`${user.username} odaya katıldı.`,
                    time:time(),
                    color:"#7f8a9a"
                }
            );

            broadcastUsers();
        }
    );

    /* =====================================================
       CHAT MESSAGE
    ===================================================== */

    socket.on(
        "chatMessage",
        data => {

            const user =
                users.get(socket.id);

            if(!user){
                return;
            }

            if(
                rateLimited(
                    messageRate,
                    socket.id,
                    8,
                    3000
                )
            ){
                return;
            }

            const text =
                cleanText(
                    data?.text,
                    2000
                );

            const room =
                data?.room;

            if(
                !text ||
                room !== user.room ||
                !allowedTextRoom(room)
            ){
                return;
            }

            const message = {
                user:user.username,
                text,
                time:time(),
                color:user.color
            };

            pushHistory(
                room,
                message
            );

            io.to(room).emit(
                "message",
                message
            );
        }
    );

    /* =====================================================
       TYPING
    ===================================================== */

    socket.on(
        "typing",
        isTyping => {

            const user =
                users.get(socket.id);

            if(!user){
                return;
            }

            if(
                rateLimited(
                    typingRate,
                    socket.id,
                    25,
                    5000
                )
            ){
                return;
            }

            socket.to(user.room).emit(
                "userTyping",
                {
                    id:socket.id,
                    username:user.username,
                    isTyping:Boolean(isTyping)
                }
            );
        }
    );

    /* =====================================================
       JOIN VOICE
    ===================================================== */

    socket.on(
        "joinVoiceChannel",
        channel => {

            const user =
                users.get(socket.id);

            if(!user){
                return;
            }

            if(
                !allowedVoiceRoom(channel)
            ){
                return;
            }

            if(
                user.voiceChannel === channel
            ){
                return;
            }

            if(user.voiceChannel){
                removeFromVoice(
                    socket,
                    true
                );
            }

            const existingPeers =
                voiceChannels[channel]
                    .map(
                        member => member.id
                    );

            user.voiceChannel =
                channel;

            socket.join(channel);

            voiceChannels[channel].push({
                id:socket.id,
                username:user.username
            });

            /*
             * Yeni kullanıcıya mevcut kullanıcıların
             * ID'lerini gönderiyoruz.
             *
             * Yeni kullanıcı offer başlatıyor.
             */

            socket.emit(
                "voicePeers",
                existingPeers
            );

            socket.to(channel).emit(
                "userJoinedVoice",
                socket.id
            );

            socket.emit(
                "voiceConnectionState",
                "Ses bağlantısı kuruluyor..."
            );

            broadcastVoiceState();
            broadcastUsers();
        }
    );

    /* =====================================================
       LEAVE VOICE
    ===================================================== */

    socket.on(
        "leaveVoiceChannel",
        channel => {

            const user =
                users.get(socket.id);

            if(!user){
                return;
            }

            if(
                user.voiceChannel !== channel
            ){
                return;
            }

            removeFromVoice(
                socket,
                true
            );
        }
    );

    /* =====================================================
       WEBRTC SIGNAL
    ===================================================== */

    socket.on(
        "signal",
        data => {

            const sender =
                users.get(socket.id);

            if(!sender){
                return;
            }

            const targetId =
                data?.to;

            const target =
                users.get(targetId);

            if(!target){
                return;
            }

            if(
                !sender.voiceChannel ||
                sender.voiceChannel !==
                target.voiceChannel
            ){
                return;
            }

            if(
                rateLimited(
                    signalRate,
                    socket.id,
                    250,
                    10000
                )
            ){
                return;
            }

            if(
                !data.signal ||
                typeof data.signal !== "object"
            ){
                return;
            }

            socket.to(targetId).emit(
                "signal",
                {
                    from:socket.id,
                    signal:data.signal
                }
            );
        }
    );

    /* =====================================================
       SPEAKING
    ===================================================== */

    socket.on(
        "speakingStatus",
        isSpeaking => {

            const user =
                users.get(socket.id);

            if(
                !user ||
                !user.voiceChannel
            ){
                return;
            }

            socket
                .to(user.voiceChannel)
                .emit(
                    "userSpeaking",
                    {
                        id:socket.id,
                        isSpeaking:Boolean(isSpeaking)
                    }
                );
        }
    );

    /* =====================================================
       SCREEN SHARE
    ===================================================== */

    socket.on(
        "screenShareStarted",
        () => {

            const user =
                users.get(socket.id);

            if(
                !user ||
                !user.voiceChannel
            ){
                return;
            }

            socket
                .to(user.voiceChannel)
                .emit(
                    "userStartedScreenShare",
                    {
                        id:socket.id,
                        username:user.username
                    }
                );
        }
    );

    socket.on(
        "screenShareStopped",
        () => {

            const user =
                users.get(socket.id);

            if(
                !user ||
                !user.voiceChannel
            ){
                return;
            }

            socket
                .to(user.voiceChannel)
                .emit(
                    "userStoppedScreenShare",
                    socket.id
                );
        }
    );

    /* =====================================================
       DISCONNECT
    ===================================================== */

    socket.on(
        "disconnect",
        reason => {

            const user =
                users.get(socket.id);

            if(!user){
                return;
            }

            console.log(
                `[DISCONNECT] ${user.username} (${reason})`
            );

            const oldRoom =
                user.room;

            removeFromVoice(
                socket,
                true
            );

            socket
                .to(oldRoom)
                .emit(
                    "message",
                    {
                        user:"Sistem",
                        text:`${user.username} ayrıldı.`,
                        time:time(),
                        color:"#7f8a9a"
                    }
                );

            users.delete(
                socket.id
            );

            messageRate.delete(
                socket.id
            );

            typingRate.delete(
                socket.id
            );

            signalRate.delete(
                socket.id
            );

            broadcastUsers();
            broadcastVoiceState();
        }
    );
});

/* =========================================================
   START
========================================================= */

server.listen(
    PORT,
    () => {

        console.log("");
        console.log("==================================");
        console.log("        WAFFLE SERVER");
        console.log("==================================");
        console.log(
            `Port: ${PORT}`
        );
        console.log(
            `TURN: ${
                process.env.TURN_URL
                    ? "AKTİF"
                    : "Yapılandırılmadı"
            }`
        );
        console.log(
            "==================================");
        console.log("");
    }
);

/* =========================================================
   CLEANUP
========================================================= */

setInterval(() => {

    const now =
        Date.now();

    for(
        const [id,entry]
        of messageRate
    ){

        if(
            now - entry.startedAt >
            30000
        ){
            messageRate.delete(id);
        }
    }

    for(
        const [id,entry]
        of typingRate
    ){

        if(
            now - entry.startedAt >
            30000
        ){
            typingRate.delete(id);
        }
    }

    for(
        const [id,entry]
        of signalRate
    ){

        if(
            now - entry.startedAt >
            30000
        ){
            signalRate.delete(id);
        }
    }

},30000);
