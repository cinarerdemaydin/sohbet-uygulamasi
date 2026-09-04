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

    socket.on('joinRoom', ({ username, password, color, room }) => {
        if (password === ROOM_PASSWORD) {
            const targetRoom = room || 'Genel';
            
            users[socket.id] = { 
                id: socket.id,
                username: username, 
                color: color || '#10b981',
                room: targetRoom
            };

            socket.join(targetRoom);
            socket.emit('loginSuccess');
            io.emit('updateUserList', Object.values(users));

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

    // Oda Değiştirme Mantığı
    socket.on('switchRoom', (newRoom) => {
        const userInfo = users[socket.id];
        if (userInfo) {
            const oldRoom = userInfo.room;
            socket.leave(oldRoom);
            
            // Eski odaya ayrıldı bilgisi
            io.to(oldRoom).emit('message', {
                user: "Sistem",
                text: `${userInfo.username} odadan ayrıldı.`,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                color: "#888888"
            });

            // Yeni odaya geçiş
            userInfo.room = newRoom;
            socket.join(newRoom);

            // Yeni odaya katıldı bilgisi
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

    // "Yazıyor..." Göstergesi (Sadece aynı odadaki kullanıcılara)
    socket.on('typing', (isTyping) => {
        const userInfo = users[socket.id];
        if (userInfo) {
            socket.to(userInfo.room).emit('userTyping', { id: socket.id, username: userInfo.username, isTyping });
        }
    });

    // Sesli Sohbet & Ekran Paylaşımı WebRTC Sinyalleşmesi
    socket.on('joinVoice', () => {
        socket.broadcast.emit('userJoinedVoice', socket.id);
    });

    socket.on('signal', (data) => {
        io.to(data.to).emit('signal', {
            from: socket.id,
            signal: data.signal
        });
    });

    socket.on('screenShareStarted', () => {
        const userInfo = users[socket.id];
        socket.broadcast.emit('userStartedScreenShare', { id: socket.id, username: userInfo ? userInfo.username : 'Kullanıcı' });
    });

    socket.on('screenShareStopped', () => {
        socket.broadcast.emit('userStoppedScreenShare', socket.id);
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
            io.to(userInfo.room).emit('message', systemMsg);
            delete users[socket.id];
            io.emit('updateUserList', Object.values(users));
            socket.broadcast.emit('userLeftVoice', socket.id);
            socket.broadcast.emit('userStoppedScreenShare', socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor...`);
});
