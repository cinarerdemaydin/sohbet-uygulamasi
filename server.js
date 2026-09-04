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

io.on('connection', (socket) => {

    socket.on('joinRoom', ({ username, password, color }) => {
        if (password === ROOM_PASSWORD) {
            users[socket.id] = { 
                id: socket.id,
                username: username, 
                color: color || '#10b981' 
            };

            socket.emit('loginSuccess');
            io.emit('updateUserList', Object.values(users));

            const systemMsg = {
                user: "Sistem",
                text: `${username} odaya katıldı.`,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                color: "#888888"
            };
            io.emit('message', systemMsg);
        } else {
            socket.emit('loginError', 'Hatalı Şifre!');
        }
    });

    socket.on('chatMessage', (data) => {
        const userInfo = users[socket.id];
        if (userInfo) {
            io.emit('message', {
                user: userInfo.username,
                text: data.text,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                color: userInfo.color
            });
        }
    });

    // "Yazıyor..." Göstergesi
    socket.on('typing', (isTyping) => {
        const userInfo = users[socket.id];
        if (userInfo) {
            socket.broadcast.emit('userTyping', { id: socket.id, username: userInfo.username, isTyping });
        }
    });

    // Sesli Sohbet WebRTC Sinyalleşmesi
    socket.on('joinVoice', () => {
        socket.broadcast.emit('userJoinedVoice', socket.id);
    });

    socket.on('signal', (data) => {
        io.to(data.to).emit('signal', {
            from: socket.id,
            signal: data.signal,
            type: data.type || 'audio'
        });
    });

    socket.on('speakingStatus', (isSpeaking) => {
        io.emit('userSpeaking', { id: socket.id, isSpeaking });
    });

    socket.on('leaveVoice', () => {
        socket.broadcast.emit('userLeftVoice', socket.id);
    });

    socket.on('disconnect', () => {
        const userInfo = users[socket.id];
        if (userInfo) {
            const systemMsg = {
                user: "Sistem",
                text: `${userInfo.username} ayrıldı.`,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                color: "#888888"
            };
            delete users[socket.id];
            io.emit('updateUserList', Object.values(users));
            io.emit('message', systemMsg);
            socket.broadcast.emit('userLeftVoice', socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor...`);
});
