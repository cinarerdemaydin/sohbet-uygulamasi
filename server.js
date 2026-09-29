const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    maxHttpBufferSize: 1e6,
    pingTimeout: 20000,
    pingInterval: 25000
});

const ROOM_PASSWORD = process.env.ROOM_PASSWORD || '123456';

if (ROOM_PASSWORD === '123456') {
    console.warn(
        'UYARI: ROOM_PASSWORD ayarlanmamış. Varsayılan şifre 123456 kullanılıyor.'
    );
}

app.disable('x-powered-by');

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


/* =========================================================
   WAFFLE AYARLARI
========================================================= */

const TEXT_ROOMS = new Set([
    'Genel',
    'Oyun',
    'Müzik'
]);

const VOICE_ROOMS = new Set([
    'Sesli - Genel',
    'Sesli - Oyun'
]);

const ALLOWED_COLORS = new Set([
    '#3b82f6',
    '#10b981',
    '#ef4444',
    '#f59e0b',
    '#8b5cf6',
    '#ec4899',
    '#06b6d4',
    '#eab308',
    '#f97316',
    '#a855f7'
]);


/* =========================================================
   DURUM
========================================================= */

const users = Object.create(null);

const voiceChannels = {
    'Sesli - Genel': [],
    'Sesli - Oyun': []
};


/* =========================================================
   RATE LIMIT
========================================================= */

const limits = {
    message: new Map(),
    typing: new Map(),
    signal: new Map()
};


/* =========================================================
   YARDIMCI FONKSİYONLAR
========================================================= */

function now() {
    return new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
    });
}


function cleanText(value, max) {
    if (typeof value !== 'string') {
        return '';
    }

    return value
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .trim()
        .slice(0, max);
}


function cleanUsername(value) {
    return cleanText(value, 24)
        .replace(/\s+/g, ' ');
}


function validColor(color) {
    return ALLOWED_COLORS.has(color)
        ? color
        : '#10b981';
}


function limited(map, id, max, windowMs) {

    const time = Date.now();

    const item = map.get(id);

    if (!item || time - item.start >= windowMs) {

        map.set(id, {
            start: time,
            count: 1
        });

        return false;
    }

    item.count++;

    return item.count > max;
}


function broadcastUsers() {
    io.emit(
        'updateUserList',
        Object.values(users)
    );
}


function broadcastVoice() {
    io.emit(
        'updateVoiceState',
        voiceChannels
    );
}


/* =========================================================
   SES KANALINDAN AYRIL
========================================================= */

function leaveVoice(socket, user, notify = true) {

    const channel = user.voiceChannel;

    if (!channel) {
        return;
    }

    if (voiceChannels[channel]) {

        voiceChannels[channel] =
            voiceChannels[channel].filter(
                userItem => userItem.id !== socket.id
            );
    }

    socket.leave(channel);

    if (notify) {

        socket
            .to(channel)
            .emit(
                'userLeftVoice',
                socket.id
            );

        socket
            .to(channel)
            .emit(
                'userStoppedScreenShare',
                socket.id
            );

        socket
            .to(channel)
            .emit(
                'userSpeaking',
                {
                    id: socket.id,
                    isSpeaking: false
                }
            );
    }

    user.voiceChannel = null;
}


/* =========================================================
   SOCKET.IO
========================================================= */

io.on('connection', socket => {


    /* =====================================================
       ODAYA GİRİŞ
    ===================================================== */

    socket.on('joinRoom', payload => {

        if (users[socket.id]) {
            return;
        }

        const username =
            cleanUsername(payload?.username);

        const password =
            typeof payload?.password === 'string'
                ? payload.password
                : '';

        const room = payload?.room;


        if (password !== ROOM_PASSWORD) {

            socket.emit(
                'loginError',
                'Hatalı Şifre!'
            );

            return;
        }


        if (
            username.length < 2 ||
            username.length > 24
        ) {

            socket.emit(
                'loginError',
                'Kullanıcı adı 2-24 karakter olmalı.'
            );

            return;
        }


        if (!TEXT_ROOMS.has(room)) {

            socket.emit(
                'loginError',
                'Geçersiz sohbet odası.'
            );

            return;
        }


        const usernameExists =
            Object.values(users).some(
                user =>
                    user.username.toLowerCase() ===
                    username.toLowerCase()
            );


        if (usernameExists) {

            socket.emit(
                'loginError',
                'Bu kullanıcı adı zaten kullanımda.'
            );

            return;
        }


        users[socket.id] = {

            id: socket.id,

            username,

            color: validColor(
                payload?.color
            ),

            room,

            voiceChannel: null
        };


        socket.join(room);

        socket.emit('loginSuccess');

        broadcastUsers();

        broadcastVoice();


        socket
            .to(room)
            .emit(
                'message',
                {
                    user: 'Sistem',

                    text: `${username} katıldı.`,

                    time: now(),

                    color: '#888888'
                }
            );
    });


    /* =====================================================
       METİN ODASI DEĞİŞTİR
    ===================================================== */

    socket.on('switchRoom', newRoom => {

        const user = users[socket.id];

        if (!user) {
            return;
        }

        if (!TEXT_ROOMS.has(newRoom)) {
            return;
        }

        if (newRoom === user.room) {
            return;
        }


        const oldRoom = user.room;


        socket
            .to(oldRoom)
            .emit(
                'message',
                {
                    user: 'Sistem',

                    text:
                        `${user.username} odadan ayrıldı.`,

                    time: now(),

                    color: '#888888'
                }
            );


        socket.leave(oldRoom);


        user.room = newRoom;


        socket.join(newRoom);


        socket
            .to(newRoom)
            .emit(
                'message',
                {
                    user: 'Sistem',

                    text:
                        `${user.username} odaya katıldı.`,

                    time: now(),

                    color: '#888888'
                }
            );
    });


    /* =====================================================
       MESAJ
    ===================================================== */

    socket.on('chatMessage', data => {

        const user = users[socket.id];

        if (!user) {
            return;
        }


        if (
            limited(
                limits.message,
                socket.id,
                8,
                3000
            )
        ) {
            return;
        }


        const text =
            cleanText(
                data?.text,
                2000
            );


        if (!text) {
            return;
        }


        if (data?.room !== user.room) {
            return;
        }


        if (!TEXT_ROOMS.has(data.room)) {
            return;
        }


        io
            .to(user.room)
            .emit(
                'message',
                {
                    user: user.username,

                    text,

                    time: now(),

                    color: user.color
                }
            );
    });


    /* =====================================================
       YAZIYOR
    ===================================================== */

    socket.on('typing', value => {

        const user = users[socket.id];

        if (!user) {
            return;
        }


        if (
            limited(
                limits.typing,
                socket.id,
                20,
                5000
            )
        ) {
            return;
        }


        socket
            .to(user.room)
            .emit(
                'userTyping',
                {
                    id: socket.id,

                    username: user.username,

                    isTyping: Boolean(value)
                }
            );
    });


    /* =====================================================
       SES KANALINA GİR
    ===================================================== */

    socket.on(
        'joinVoiceChannel',
        channel => {

            const user = users[socket.id];

            if (!user) {
                return;
            }


            if (!VOICE_ROOMS.has(channel)) {
                return;
            }


            if (user.voiceChannel === channel) {
                return;
            }


            leaveVoice(
                socket,
                user,
                true
            );


            const peers =
                voiceChannels[channel]
                    .map(
                        userItem => userItem.id
                    );


            user.voiceChannel = channel;


            socket.join(channel);


            voiceChannels[channel].push({

                id: socket.id,

                username: user.username
            });


            socket.emit(
                'voicePeers',
                peers
            );


            socket
                .to(channel)
                .emit(
                    'userJoinedVoice',
                    socket.id
                );


            broadcastVoice();
        }
    );


    /* =====================================================
       SES KANALINDAN ÇIK
    ===================================================== */

    socket.on(
        'leaveVoiceChannel',
        channel => {

            const user = users[socket.id];

            if (!user) {
                return;
            }


            if (user.voiceChannel !== channel) {
                return;
            }


            leaveVoice(
                socket,
                user,
                true
            );


            broadcastVoice();
        }
    );


    /* =====================================================
       WEBRTC SIGNAL
    ===================================================== */

    socket.on('signal', data => {

        const sender =
            users[socket.id];

        const target =
            users[data?.to];


        if (!sender || !target) {
            return;
        }


        if (!sender.voiceChannel) {
            return;
        }


        if (
            sender.voiceChannel !==
            target.voiceChannel
        ) {
            return;
        }


        if (
            limited(
                limits.signal,
                socket.id,
                180,
                10000
            )
        ) {
            return;
        }


        if (
            !data?.signal ||
            typeof data.signal !== 'object'
        ) {
            return;
        }


        socket
            .to(data.to)
            .emit(
                'signal',
                {
                    from: socket.id,

                    signal: data.signal
                }
            );
    });


    /* =====================================================
       EKRAN PAYLAŞIMI
    ===================================================== */

    socket.on(
        'screenShareStarted',
        () => {

            const user =
                users[socket.id];


            if (
                user?.voiceChannel
            ) {

                socket
                    .to(user.voiceChannel)
                    .emit(
                        'userStartedScreenShare',
                        {
                            id: socket.id,

                            username:
                                user.username
                        }
                    );
            }
        }
    );


    socket.on(
        'screenShareStopped',
        () => {

            const user =
                users[socket.id];


            if (
                user?.voiceChannel
            ) {

                socket
                    .to(user.voiceChannel)
                    .emit(
                        'userStoppedScreenShare',
                        socket.id
                    );
            }
        }
    );


    /* =====================================================
       KONUŞMA DURUMU
    ===================================================== */

    socket.on(
        'speakingStatus',
        value => {

            const user =
                users[socket.id];


            if (
                user?.voiceChannel
            ) {

                socket
                    .to(user.voiceChannel)
                    .emit(
                        'userSpeaking',
                        {
                            id: socket.id,

                            isSpeaking:
                                Boolean(value)
                        }
                    );
            }
        }
    );


    /* =====================================================
       BAĞLANTI KESİLDİ
    ===================================================== */

    socket.on(
        'disconnect',
        () => {

            const user =
                users[socket.id];


            if (!user) {
                return;
            }


            leaveVoice(
                socket,
                user,
                true
            );


            socket
                .to(user.room)
                .emit(
                    'message',
                    {
                        user: 'Sistem',

                        text:
                            `${user.username} ayrıldı.`,

                        time: now(),

                        color: '#888888'
                    }
                );


            delete users[socket.id];


            Object.values(limits)
                .forEach(
                    map =>
                        map.delete(socket.id)
                );


            broadcastUsers();

            broadcastVoice();
        }
    );
});


/* =========================================================
   SUNUCU
========================================================= */

const PORT =
    Number(process.env.PORT) || 3000;


server.listen(
    PORT,
    () => {

        console.log(
            `WAFFLE sunucusu ${PORT} portunda çalışıyor.`
        );
    }
);
