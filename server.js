const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const PORT = process.env.PORT || 3000; 

http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
app.use(express.static(__dirname));
app.use(express.json());
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});
let orders = []; // Database sementara

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

http.listen(3000, () => console.log('POS System Ready: http://localhost:3000'));