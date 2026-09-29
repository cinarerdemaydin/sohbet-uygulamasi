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

// Üretimde mutlaka ortam değişkeni kullan:
// Windows PowerShell: $env:ROOM_PASSWORD="çok-güçlü-şifre"
const ROOM_PASSWORD = process.env.ROOM_PASSWORD || '123456';

if (ROOM_PASSWORD === '123456') {
    console.warn('UYARI: ROOM_PASSWORD ayarlanmamış. Varsayılan şifre 123456 kullanılıyor.');
}

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const TEXT_ROOMS = new Set(['Genel', 'Oyun', 'Müzik']);
const VOICE_ROOMS = new Set(['Sesli - Genel', 'Sesli - Oyun']);

const ALLOWED_COLORS = new Set([
    '#3b82f6',
    '#10b981',
    '#ef4444',
    '#f59e0b',
    '#8b5cf6',
    '#ec4899',
    '#06b6d4'
]);

const users = Object.create(null);

const voiceChannels = {
    'Sesli - Genel': [],
    'Sesli - Oyun': []
};

// Basit server-side rate limit.
const messageRate = new Map();
const typingRate = new Map();
const signalRate = new Map();

function now() {
    return new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
    });
}

function cleanText(value, maxLength) {
    if (typeof value !== 'string') return '';

    return value
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .trim()
        .slice(0, maxLength);
}

function cleanUsername(value) {
    return cleanText(value, 24).replace(/\s+/g, ' ');
}

function validColor(color) {
    return ALLOWED_COLORS.has(color)
        ? color
        : '#10b981';
}

function isAllowedTextRoom(room) {
    return TEXT_ROOMS.has(room);
}

function isAllowedVoiceRoom(room) {
    return VOICE_ROOMS.has(room);
}

function rateLimited(map, id, limit, windowMs) {
    const nowMs = Date.now();
    const entry = map.get(id);

    if (!entry || nowMs - entry.startedAt >= windowMs) {
        map.set(id, {
            startedAt: nowMs,
            count: 1
        });

        return false;
    }

    entry.count += 1;

    return entry.count > limit;
}

function removeFromVoice(socket, userInfo, notify = true) {
    const channel = userInfo?.voiceChannel;

    if (!channel) return;

    if (voiceChannels[channel]) {
        voiceChannels[channel] =
            voiceChannels[channel].filter(
                user => user.id !== socket.id
            );
    }

    socket.leave(channel);

    if (notify) {
        socket.to(channel).emit(
            'userLeftVoice',
            socket.id
        );

        socket.to(channel).emit(
            'userStoppedScreenShare',
            socket.id
        );
    }

    userInfo.voiceChannel = null;
}

function broadcastVoiceState() {
    io.emit(
        'updateVoiceState',
        voiceChannels
    );
}

function broadcastUserList() {
    io.emit(
        'updateUserList',
        Object.values(users)
    );
}

io.on('connection', socket => {

    socket.on('joinRoom', payload => {

        if (users[socket.id]) return;

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

        if (!isAllowedTextRoom(room)) {
            socket.emit(
                'loginError',
                'Geçersiz sohbet odası.'
            );

            return;
        }

        const duplicate =
            Object.values(users).some(
                user =>
                    user.username.toLowerCase() ===
                    username.toLowerCase()
            );

        if (duplicate) {
            socket.emit(
                'loginError',
                'Bu kullanıcı adı zaten kullanımda.'
            );

            return;
        }

        users[socket.id] = {
            id: socket.id,
            username,
            color: validColor(payload?.color),
            room,
            voiceChannel: null
        };

        socket.join(room);

        socket.emit('loginSuccess');

        broadcastUserList();
        broadcastVoiceState();

        socket.to(room).emit('message', {
            user: 'Sistem',
            text: `${username} katıldı.`,
            time: now(),
            color: '#888888'
        });
    });

    socket.on('switchRoom', newRoom => {

        const userInfo = users[socket.id];

        if (
            !userInfo ||
            !isAllowedTextRoom(newRoom) ||
            newRoom === userInfo.room
        ) {
            return;
        }

        const oldRoom = userInfo.room;

        socket.to(oldRoom).emit('message', {
            user: 'Sistem',
            text: `${userInfo.username} odadan ayrıldı.`,
            time: now(),
            color: '#888888'
        });

        socket.leave(oldRoom);

        userInfo.room = newRoom;

        socket.join(newRoom);

        socket.to(newRoom).emit('message', {
            user: 'Sistem',
            text: `${userInfo.username} odaya katıldı.`,
            time: now(),
            color: '#888888'
        });
    });

    socket.on('chatMessage', data => {

        const userInfo = users[socket.id];

        if (
            !userInfo ||
            rateLimited(
                messageRate,
                socket.id,
                8,
                3000
            )
        ) {
            return;
        }

        const text =
            cleanText(data?.text, 2000);

        const room = data?.room;

        if (
            !text ||
            room !== userInfo.room ||
            !isAllowedTextRoom(room)
        ) {
            return;
        }

        io.to(userInfo.room).emit(
            'message',
            {
                user: userInfo.username,
                text,
                time: now(),
                color: userInfo.color
            }
        );
    });

    socket.on('typing', isTyping => {

        const userInfo = users[socket.id];

        if (
            !userInfo ||
            rateLimited(
                typingRate,
                socket.id,
                20,
                5000
            )
        ) {
            return;
        }

        socket.to(userInfo.room).emit(
            'userTyping',
            {
                id: socket.id,
                username: userInfo.username,
                isTyping: Boolean(isTyping)
            }
        );
    });

    socket.on('joinVoiceChannel', channelName => {

        const userInfo = users[socket.id];

        if (
            !userInfo ||
            !isAllowedVoiceRoom(channelName)
        ) {
            return;
        }

        if (
            userInfo.voiceChannel === channelName
        ) {
            return;
        }

        removeFromVoice(
            socket,
            userInfo,
            true
        );

        const existingPeers =
            voiceChannels[channelName]
                .map(user => user.id);

        userInfo.voiceChannel = channelName;

        socket.join(channelName);

        voiceChannels[channelName].push({
            id: socket.id,
            username: userInfo.username
        });

        // Sadece yeni katılan taraf offer başlatıyor.
        socket.emit(
            'voicePeers',
            existingPeers
        );

        socket.to(channelName).emit(
            'userJoinedVoice',
            socket.id
        );

        broadcastVoiceState();
    });

    socket.on('leaveVoiceChannel', channelName => {

        const userInfo = users[socket.id];

        if (
            !userInfo ||
            userInfo.voiceChannel !== channelName
        ) {
            return;
        }

        removeFromVoice(
            socket,
            userInfo,
            true
        );

        broadcastVoiceState();
    });

    socket.on('signal', data => {

        const sender = users[socket.id];
        const target = users[data?.to];

        // Sadece aynı ses kanalındaki kişiler
        // WebRTC sinyali gönderebilir.
        if (
            !sender ||
            !target ||
            !sender.voiceChannel ||
            sender.voiceChannel !== target.voiceChannel
        ) {
            return;
        }

        if (
            rateLimited(
                signalRate,
                socket.id,
                150,
                10000
            )
        ) {
            return;
        }

        if (
            !data.signal ||
            typeof data.signal !== 'object'
        ) {
            return;
        }

        socket.to(data.to).emit(
            'signal',
            {
                from: socket.id,
                signal: data.signal
            }
        );
    });

    socket.on('screenShareStarted', () => {

        const userInfo = users[socket.id];

        if (userInfo?.voiceChannel) {
            socket
                .to(userInfo.voiceChannel)
                .emit(
                    'userStartedScreenShare',
                    {
                        id: socket.id,
                        username: userInfo.username
                    }
                );
        }
    });

    socket.on('screenShareStopped', () => {

        const userInfo = users[socket.id];

        if (userInfo?.voiceChannel) {
            socket
                .to(userInfo.voiceChannel)
                .emit(
                    'userStoppedScreenShare',
                    socket.id
                );
        }
    });

    socket.on('speakingStatus', isSpeaking => {

        const userInfo = users[socket.id];

        if (userInfo?.voiceChannel) {

            socket
                .to(userInfo.voiceChannel)
                .emit(
                    'userSpeaking',
                    {
                        id: socket.id,
                        isSpeaking: Boolean(isSpeaking)
                    }
                );
        }
    });

    socket.on('disconnect', () => {

        const userInfo = users[socket.id];

        if (!userInfo) return;

        removeFromVoice(
            socket,
            userInfo,
            true
        );

        socket.to(userInfo.room).emit(
            'message',
            {
                user: 'Sistem',
                text: `${userInfo.username} ayrıldı.`,
                time: now(),
                color: '#888888'
            }
        );

        delete users[socket.id];

        messageRate.delete(socket.id);
        typingRate.delete(socket.id);
        signalRate.delete(socket.id);

        broadcastUserList();
        broadcastVoiceState();
    });
});

const PORT =
    Number(process.env.PORT) || 3000;

server.listen(PORT, () => {
    console.log(
        `WAFFLE sunucusu ${PORT} portunda çalışıyor.`
    );
});
