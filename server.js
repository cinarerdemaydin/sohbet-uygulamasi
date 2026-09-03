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

// Belirlediğin Özel Oda Şifresi
const ODA_SIFRESI = "1234"; 

// Aktif kullanıcılar
let activeUsers = {};

io.on('connection', (socket) => {

    // Kullanıcı giriş yapmaya çalıştığında
    socket.on('joinRoom', ({ username, password }) => {
        if (password === ODA_SIFRESI) {
            socket.username = username;
            activeUsers[socket.id] = username;

            socket.emit('loginSuccess');
            
            // Tüm kullanıcılara yeni aktif listesini gönder
            io.emit('updateUserList', Object.values(activeUsers));
        } else {
            socket.emit('loginError', 'Hatalı oda şifresi!');
        }
    });

    // Mesaj iletimi
    socket.on('chatMessage', (data) => {
        io.emit('message', {
            user: data.user,
            text: data.text,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
    });

    // Kullanıcı ayrıldığında
    socket.on('disconnect', () => {
        if (socket.id in activeUsers) {
            delete activeUsers[socket.id];
            io.emit('updateUserList', Object.values(activeUsers));
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Sunucu aktif: http://localhost:${PORT}`);
});