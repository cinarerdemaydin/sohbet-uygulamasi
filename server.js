const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

const ODA_SIFRESI = "1234";
let activeUsers = {};

io.on('connection', (socket) => {

    socket.on('joinRoom', ({ username, password }) => {
        if (password === ODA_SIFRESI) {
            socket.username = username;
            activeUsers[socket.id] = username;
            socket.emit('loginSuccess');
            io.emit('updateUserList', Object.values(activeUsers));
        } else {
            socket.emit('loginError', 'Hatalı oda şifresi!');
        }
    });

    socket.on('chatMessage', (data) => {
        io.emit('message', {
            user: data.user,
            text: data.text,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
    });

    socket.on('joinVoice', () => {
        socket.broadcast.emit('userJoinedVoice', socket.id);
    });

    socket.on('signal', (data) => {
        io.to(data.to).emit('signal', { from: socket.id, signal: data.signal });
    });

    socket.on('leaveVoice', () => {
        socket.broadcast.emit('userLeftVoice', socket.id);
    });

    socket.on('disconnect', () => {
        if (socket.id in activeUsers) {
            delete activeUsers[socket.id];
            io.emit('updateUserList', Object.values(activeUsers));
            socket.broadcast.emit('userLeftVoice', socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu aktif: http://localhost:${PORT}`);
});