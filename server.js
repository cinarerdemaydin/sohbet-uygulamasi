const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');


/* =========================================================
   SERVER
========================================================= */

const app = express();

const server =
    http.createServer(app);

const io =
    new Server(server, {

        maxHttpBufferSize:
            1e6,

        pingTimeout:
            20000,

        pingInterval:
            25000,

        cors:{
            origin:true,
            credentials:false
        }

    });


/* =========================================================
   CONFIG
========================================================= */

const PORT =
    Number(process.env.PORT) || 3000;

const ROOM_PASSWORD =
    process.env.ROOM_PASSWORD ||
    '123456';


const TEXT_ROOMS = [
    'Genel',
    'Oyun',
    'Müzik'
];


const VOICE_ROOMS = [
    'Sesli - Genel',
    'Sesli - Oyun'
];


const COLORS =
    new Set([
        '#8b5cf6',
        '#22c55e',
        '#3b82f6',
        '#ef4444',
        '#f59e0b',
        '#ec4899',
        '#06b6d4',
        '#a855f7'
    ]);


/* =========================================================
   STATE
========================================================= */

const users =
    Object.create(null);


const voiceChannels = {

    'Sesli - Genel': [],

    'Sesli - Oyun': []

};


const history =
    Object.fromEntries(
        TEXT_ROOMS.map(
            room => [
                room,
                []
            ]
        )
    );


const limits = {

    message:
        new Map(),

    typing:
        new Map(),

    signal:
        new Map()

};


/* =========================================================
   EXPRESS
========================================================= */

app.disable(
    'x-powered-by'
);


app.use(
    express.static(
        path.join(
            __dirname,
            'public'
        )
    )
);


app.get(
    '/health',
    (req,res) => {

        res.json({

            ok:true,

            service:'WAFFLE',

            users:
                Object.keys(
                    users
                ).length,

            uptime:
                Math.round(
                    process.uptime()
                )

        });

    }
);


app.get(
    '/',
    (req,res) => {

        res.sendFile(
            path.join(
                __dirname,
                'public',
                'index.html'
            )
        );

    }
);


/* =========================================================
   HELPERS
========================================================= */

function now(){

    return new Date()
        .toLocaleTimeString(
            'tr-TR',
            {
                hour:'2-digit',
                minute:'2-digit'
            }
        );

}


function clean(
    value,
    max
){

    if(
        typeof value !==
        'string'
    ){

        return '';

    }


    return value

        .replace(
            /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
            ''
        )

        .trim()

        .slice(
            0,
            max
        );

}


function username(value){

    return clean(
        value,
        24
    )
    .replace(
        /\s+/g,
        ' '
    );

}


function validColor(value){

    return COLORS.has(value)
        ? value
        : '#8b5cf6';

}


function limited(
    map,
    id,
    max,
    windowMs
){

    const time =
        Date.now();


    const item =
        map.get(id);


    if(
        !item ||
        time - item.start >=
        windowMs
    ){

        map.set(
            id,
            {
                start:time,
                count:1
            }
        );

        return false;

    }


    item.count++;


    return item.count >
        max;

}


function broadcastUsers(){

    io.emit(
        'updateUserList',
        Object.values(users)
    );

}


function broadcastVoice(){

    io.emit(
        'updateVoiceState',
        voiceChannels
    );

}


function addHistory(
    room,
    message
){

    history[room]
        .push(message);


    if(
        history[room].length >
        100
    ){

        history[room]
            .shift();

    }

}


function system(
    room,
    text,
    except
){

    const message = {

        user:'Sistem',

        text,

        time:now(),

        color:'#6f7888'

    };


    addHistory(
        room,
        message
    );


    if(except){

        io.to(room)
            .except(except)
            .emit(
                'message',
                message
            );

    }else{

        io.to(room)
            .emit(
                'message',
                message
            );

    }

}


/* =========================================================
   VOICE CLEANUP
========================================================= */

function leaveVoice(
    socket,
    user,
    notify = true
){

    const channel =
        user.voiceChannel;


    if(!channel)
        return;


    if(
        voiceChannels[channel]
    ){

        voiceChannels[channel] =
            voiceChannels[channel]
            .filter(
                item =>
                    item.id !==
                    socket.id
            );

    }


    socket.leave(
        channel
    );


    if(notify){

        socket.to(channel)
            .emit(
                'userLeftVoice',
                socket.id
            );


        socket.to(channel)
            .emit(
                'userStoppedScreenShare',
                socket.id
            );


        socket.to(channel)
            .emit(
                'userSpeaking',
                {
                    id:socket.id,
                    isSpeaking:false
                }
            );

    }


    user.voiceChannel =
        null;

}


/* =========================================================
   SOCKET.IO
========================================================= */

io.on(
    'connection',
    socket => {


        /* =================================================
           LOGIN
        ================================================= */

        socket.on(
            'joinRoom',
            payload => {

                if(
                    users[socket.id]
                )
                    return;


                const name =
                    username(
                        payload?.username
                    );


                const password =
                    typeof payload?.password ===
                    'string'
                    ?
                    payload.password
                    :
                    '';


                const room =
                    payload?.room;


                if(
                    password !==
                    ROOM_PASSWORD
                ){

                    socket.emit(
                        'loginError',
                        'Hatalı şifre.'
                    );

                    return;

                }


                if(
                    name.length < 2 ||
                    name.length > 24
                ){

                    socket.emit(
                        'loginError',
                        'Kullanıcı adı 2-24 karakter olmalı.'
                    );

                    return;

                }


                if(
                    !TEXT_ROOMS.includes(
                        room
                    )
                ){

                    socket.emit(
                        'loginError',
                        'Geçersiz sohbet odası.'
                    );

                    return;

                }


                const duplicate =
                    Object.values(users)
                    .some(
                        user =>
                            user.username
                                .toLowerCase() ===
                            name.toLowerCase()
                    );


                if(duplicate){

                    socket.emit(
                        'loginError',
                        'Bu kullanıcı adı zaten kullanımda.'
                    );

                    return;

                }


                users[socket.id] = {

                    id:
                        socket.id,

                    username:
                        name,

                    color:
                        validColor(
                            payload?.color
                        ),

                    room,

                    voiceChannel:
                        null

                };


                socket.join(
                    room
                );


                socket.emit(
                    'loginSuccess'
                );


                socket.emit(
                    'roomHistory',
                    {
                        room,

                        messages:
                            history[room]
                    }
                );


                broadcastUsers();

                broadcastVoice();


                system(
                    room,
                    `${name} katıldı.`,
                    socket.id
                );

            }
        );


        /* =================================================
           ROOM SWITCH
        ================================================= */

        socket.on(
            'switchRoom',
            room => {

                const user =
                    users[socket.id];


                if(
                    !user ||
                    !TEXT_ROOMS.includes(
                        room
                    ) ||
                    room === user.room
                )
                    return;


                const old =
                    user.room;


                system(
                    old,
                    `${user.username} odadan ayrıldı.`
                );


                socket.leave(
                    old
                );


                user.room =
                    room;


                socket.join(
                    room
                );


                socket.emit(
                    'roomHistory',
                    {
                        room,

                        messages:
                            history[room]
                    }
                );


                system(
                    room,
                    `${user.username} odaya katıldı.`,
                    socket.id
                );


                broadcastUsers();

            }
        );


        /* =================================================
           CHAT MESSAGE
        ================================================= */

        socket.on(
            'chatMessage',
            data => {

                const user =
                    users[socket.id];


                if(
                    !user ||
                    limited(
                        limits.message,
                        socket.id,
                        8,
                        3000
                    )
                )
                    return;


                const text =
                    clean(
                        data?.text,
                        2000
                    );


                if(
                    !text ||
                    data?.room !==
                    user.room ||
                    !TEXT_ROOMS.includes(
                        data.room
                    )
                )
                    return;


                const message = {

                    user:
                        user.username,

                    text,

                    time:
                        now(),

                    color:
                        user.color

                };


                addHistory(
                    user.room,
                    message
                );


                io.to(user.room)
                    .emit(
                        'message',
                        message
                    );

            }
        );


        /* =================================================
           TYPING
        ================================================= */

        socket.on(
            'typing',
            value => {

                const user =
                    users[socket.id];


                if(
                    !user ||
                    limited(
                        limits.typing,
                        socket.id,
                        20,
                        5000
                    )
                )
                    return;


                socket
                    .to(user.room)
                    .emit(
                        'userTyping',
                        {
                            id:
                                socket.id,

                            username:
                                user.username,

                            isTyping:
                                Boolean(value)
                        }
                    );

            }
        );


        /* =================================================
           JOIN VOICE
        ================================================= */

        socket.on(
            'joinVoiceChannel',
            channel => {

                const user =
                    users[socket.id];


                if(
                    !user ||
                    !VOICE_ROOMS.includes(
                        channel
                    ) ||
                    user.voiceChannel ===
                    channel
                )
                    return;


                leaveVoice(
                    socket,
                    user,
                    true
                );


                const peers =
                    voiceChannels[channel]
                    .map(
                        item =>
                            item.id
                    );


                user.voiceChannel =
                    channel;


                socket.join(
                    channel
                );


                voiceChannels[channel]
                    .push({

                        id:
                            socket.id,

                        username:
                            user.username

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

                broadcastUsers();

            }
        );


        /* =================================================
           LEAVE VOICE
        ================================================= */

        socket.on(
            'leaveVoiceChannel',
            channel => {

                const user =
                    users[socket.id];


                if(
                    !user ||
                    user.voiceChannel !==
                    channel
                )
                    return;


                leaveVoice(
                    socket,
                    user,
                    true
                );


                broadcastVoice();

                broadcastUsers();

            }
        );


        /* =================================================
           WEBRTC SIGNAL
        ================================================= */

        socket.on(
            'signal',
            data => {

                const sender =
                    users[socket.id];


                const target =
                    users[data?.to];


                if(
                    !sender ||
                    !target ||
                    !sender.voiceChannel ||
                    sender.voiceChannel !==
                    target.voiceChannel
                )
                    return;


                if(
                    limited(
                        limits.signal,
                        socket.id,
                        180,
                        10000
                    )
                )
                    return;


                if(
                    !data?.signal ||
                    typeof data.signal !==
                    'object'
                )
                    return;


                socket
                    .to(data.to)
                    .emit(
                        'signal',
                        {
                            from:
                                socket.id,

                            signal:
                                data.signal
                        }
                    );

            }
        );


        /* =================================================
           SCREEN SHARE
        ================================================= */

        socket.on(
            'screenShareStarted',
            () => {

                const user =
                    users[socket.id];


                if(
                    user?.voiceChannel
                ){

                    socket
                        .to(user.voiceChannel)
                        .emit(
                            'userStartedScreenShare',
                            {
                                id:
                                    socket.id,

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


                if(
                    user?.voiceChannel
                ){

                    socket
                        .to(user.voiceChannel)
                        .emit(
                            'userStoppedScreenShare',
                            socket.id
                        );

                }

            }
        );


        /* =================================================
           SPEAKING
        ================================================= */

        socket.on(
            'speakingStatus',
            value => {

                const user =
                    users[socket.id];


                if(
                    user?.voiceChannel
                ){

                    socket
                        .to(user.voiceChannel)
                        .emit(
                            'userSpeaking',
                            {
                                id:
                                    socket.id,

                                isSpeaking:
                                    Boolean(value)
                            }
                        );

                }

            }
        );


        /* =================================================
           DISCONNECT
        ================================================= */

        socket.on(
            'disconnect',
            () => {

                const user =
                    users[socket.id];


                if(!user)
                    return;


                leaveVoice(
                    socket,
                    user,
                    true
                );


                system(
                    user.room,
                    `${user.username} ayrıldı.`
                );


                delete users[
                    socket.id
                ];


                Object.values(
                    limits
                )
                .forEach(
                    map =>
                        map.delete(
                            socket.id
                        )
                );


                broadcastUsers();

                broadcastVoice();

            }
        );

    }
);


/* =========================================================
   START
========================================================= */

server.listen(
    PORT,
    () => {

        console.log(
            `WAFFLE sunucusu ${PORT} portunda çalışıyor.`
        );

    }
);
