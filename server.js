const express = require('express');
const path = require('path');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

const PORT = process.env.PORT || 3000; 

app.use(express.static(__dirname));
app.use(express.json());

// DATA MENU PUSAT (Kebenaran Tunggal)
const officialMenu = [
    { id:1, name: "Iced Latte", price: 25000, fee: 2000, stand: "O-Coffee Stand" },
    { id:2, name: "Nasi Goreng Special", price: 30000, fee: 3000, stand: "Dapur Mamah" },
    { id:3, name: "Es Teh Manis", price: 5000, fee: 1000, stand: "O-Coffee Stand" },
    { id:4, name: "Ayam Goreng", price: 22000, fee: 2000, stand: "Dapur Mamah" }
];

let orders = []; 

io.on('connection', (socket) => {
    
    socket.on('submit_order', (clientData) => {
        // --- PROSES VALIDASI (CYBERSECURITY) ---
        let validatedItems = [];
        let subtotal = 0;

        clientData.items.forEach(clientItem => {
            const original = officialMenu.find(m => m.name === clientItem.name);
            if (original) {
                const itemTotal = original.price + original.fee;
                validatedItems.push({
                    name: original.name,
                    total: itemTotal,
                    stand: original.stand
                });
                subtotal += itemTotal;
            }
        });

        const ppn = subtotal * 0.11;
        const grandTotal = subtotal + ppn;

        // Data yang disimpan adalah hasil hitung ulang SERVER
        const finalOrder = {
            id: clientData.id,
            user: clientData.user,
            table: clientData.table,
            items: validatedItems,
            subtotal: subtotal,
            ppn: ppn,
            total: grandTotal,
            status: 'WAITING_PAYMENT',
            time: new Date().toLocaleTimeString()
        };

        orders.push(finalOrder);
        io.emit('new_order_to_cashier', finalOrder);
        // Kirim update ke admin setiap ada order masuk
        io.emit('admin_update', calculateStats());
    });

    socket.on('confirm_payment', (orderId) => {
        let order = orders.find(o => o.id === orderId);
        if (order) {
            order.status = 'PAID';
            io.emit('order_paid_broadcast', order);
            io.emit('admin_update', calculateStats()); // Update statistik admin
        }
    });

    // Kirim data awal saat admin buka halaman
    socket.on('get_admin_stats', () => {
        socket.emit('admin_update', calculateStats());
    });
});

// Fungsi Hitung Statistik untuk Admin
function calculateStats() {
    let stats = {
        totalSales: 0,
        paidOrders: 0,
        standRevenue: {},
        topItems: {}
    };

    orders.filter(o => o.status === 'PAID').forEach(o => {
        stats.totalSales += o.total;
        stats.paidOrders++;
        o.items.forEach(item => {
            // Per Stand
            stats.standRevenue[item.stand] = (stats.standRevenue[item.stand] || 0) + item.total;
            // Per Item
            stats.topItems[item.name] = (stats.topItems[item.name] || 0) + 1;
        });
    });
    return stats;
}

http.listen(PORT, () => {
    console.log(`POS System Secure & Ready on port ${PORT}`);
});