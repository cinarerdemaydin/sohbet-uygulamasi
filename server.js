const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ROOM_PASSWORD = process.env.ROOM_PASSWORD || "123456";

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const users = {};
const voiceChannels = {
    "Sesli - Genel": [],
    "Sesli - Oyun": []
};

function broadcastVoiceState() {
    io.emit('updateVoiceState', voiceChannels);
}

io.on('connection', (socket) => {

    socket.on('joinRoom', ({ username, password, color, room }) => {
        if (password === ROOM_PASSWORD) {
            const targetRoom = room || 'Genel';
            
            users[socket.id] = { 
                id: socket.id,
                username: username, 
                color: color || '#10b981',
                room: targetRoom,
                voiceChannel: null
            };

            socket.join(targetRoom);
            socket.emit('loginSuccess');
            io.emit('updateUserList', Object.values(users));
            broadcastVoiceState();

            const systemMsg = {
                user: "Sistem",
                text: `${username} katıldı.`,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                color: "#888888"
            };
            io.to(targetRoom).emit('message', systemMsg);
        } else {
            socket.emit('loginError', 'Hatalı Şifre!');
        }
    });

    socket.on('switchRoom', (newRoom) => {
        const userInfo = users[socket.id];
        if (userInfo) {
            const oldRoom = userInfo.room;
            socket.leave(oldRoom);
            
            io.to(oldRoom).emit('message', {
                user: "Sistem",
                text: `${userInfo.username} odadan ayrıldı.`,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                color: "#888888"
            });

            userInfo.room = newRoom;
            socket.join(newRoom);

            io.to(newRoom).emit('message', {
                user: "Sistem",
                text: `${userInfo.username} odaya katıldı.`,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                color: "#888888"
            });
        }
    });

    socket.on('chatMessage', (data) => {
        const userInfo = users[socket.id];
        if (userInfo) {
            const roomToSend = data.room || userInfo.room;
            io.to(roomToSend).emit('message', {
                user: userInfo.username,
                text: data.text,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                color: userInfo.color
            });
        }
    });

    socket.on('typing', (isTyping) => {
        const userInfo = users[socket.id];
        if (userInfo) {
            socket.to(userInfo.room).emit('userTyping', { id: socket.id, username: userInfo.username, isTyping });
        }
    });

    socket.on('joinVoiceChannel', (channelName) => {
        const userInfo = users[socket.id];
        if (!userInfo) return;

        if (userInfo.voiceChannel) {
            socket.leave(userInfo.voiceChannel);
            if (voiceChannels[userInfo.voiceChannel]) {
                voiceChannels[userInfo.voiceChannel] = voiceChannels[userInfo.voiceChannel].filter(u => u.id !== socket.id);
            }
            socket.to(userInfo.voiceChannel).emit('userLeftVoice', socket.id);
        }

        userInfo.voiceChannel = channelName;
        socket.join(channelName);

        if (!voiceChannels[channelName]) {
            voiceChannels[channelName] = [];
        }
        voiceChannels[channelName].push({ id: socket.id, username: userInfo.username });

        socket.to(channelName).emit('userJoinedVoice', socket.id);
        broadcastVoiceState();
    });

    socket.on('leaveVoiceChannel', (channelName) => {
        const userInfo = users[socket.id];
        if (userInfo) {
            userInfo.voiceChannel = null;
        }

        socket.leave(channelName);
        if (voiceChannels[channelName]) {
            voiceChannels[channelName] = voiceChannels[channelName].filter(u => u.id !== socket.id);
        }

        socket.to(channelName).emit('userLeftVoice', socket.id);
        broadcastVoiceState();
    });

    socket.on('signal', (data) => {
        io.to(data.to).emit('signal', {
            from: socket.id,
            signal: data.signal
        });
    });

    socket.on('screenShareStarted', () => {
        const userInfo = users[socket.id];
        if (userInfo && userInfo.voiceChannel) {
            socket.to(userInfo.voiceChannel).emit('userStartedScreenShare', { id: socket.id, username: userInfo.username });
        }
    });

    socket.on('screenShareStopped', () => {
        const userInfo = users[socket.id];
        if (userInfo && userInfo.voiceChannel) {
            socket.to(userInfo.voiceChannel).emit('userStoppedScreenShare', socket.id);
        }
    });

    socket.on('speakingStatus', (isSpeaking) => {
        io.emit('userSpeaking', { id: socket.id, isSpeaking });
    });

    socket.on('disconnect', () => {
        const userInfo = users[socket.id];
        if (userInfo) {
            if (userInfo.voiceChannel) {
                socket.to(userInfo.voiceChannel).emit('userLeftVoice', socket.id);
                socket.to(userInfo.voiceChannel).emit('userStoppedScreenShare', socket.id);
                if (voiceChannels[userInfo.voiceChannel]) {
                    voiceChannels[userInfo.voiceChannel] = voiceChannels[userInfo.voiceChannel].filter(u => u.id !== socket.id);
                }
            }

            const systemMsg = {
                user: "Sistem",
                text: `${userInfo.username} ayrıldı.`,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                color: "#888888"
            };
            io.to(userInfo.room).emit('message', systemMsg);
            
            delete users[socket.id];
            io.emit('updateUserList', Object.values(users));
            broadcastVoiceState();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor...`);
});
