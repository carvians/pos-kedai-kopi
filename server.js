const express = require('express');
const path = require('path'); // Tambahkan ini agar tidak error saat panggil path
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// 1. Setting Port (Hanya satu kali di sini)
const PORT = process.env.PORT || 3000; 

// 2. Middleware & Routing
app.use(express.static(__dirname));
app.use(express.json());

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

// 3. Database Sementara
let orders = []; 

// 4. Socket.io Logic
io.on('connection', (socket) => {
    // Saat pelanggan kirim order
    socket.on('submit_order', (data) => {
        data.status = 'WAITING_PAYMENT';
        orders.push(data);
        io.emit('new_order_to_cashier', data);
    });

    // Saat kasir konfirmasi bayar
    socket.on('confirm_payment', (orderId) => {
        let order = orders.find(o => o.id === orderId);
        if (order) {
            order.status = 'PAID';
            io.emit('order_paid_broadcast', order);
        }
    });
});

// 5. Jalankan Server (HANYA SEKALI DI SINI)
http.listen(PORT, () => {
    console.log(`POS System Ready on port ${PORT}`);
});