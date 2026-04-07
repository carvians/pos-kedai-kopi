const express = require('express');
const path = require('path');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

const PORT = process.env.PORT || 3000; 

// --- FIX ROUTING UNTUK RAILWAY ---
app.use(express.static(path.join(__dirname, '/')));
app.use(express.json());

// Jalur Utama (Wajib mengarah ke login.html)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

// Jalur Pengaman: Jika user akses namafile.html secara manual
app.get('/:page.html', (req, res) => {
    res.sendFile(path.join(__dirname, req.params.page + '.html'));
});

// DATA MENU PUSAT
const officialMenu = [
    { id:1, name: "Iced Latte", price: 25000, fee: 2000, stand: "O-Coffee Stand" },
    { id:2, name: "Nasi Goreng Special", price: 30000, fee: 3000, stand: "Dapur Mamah" },
    { id:3, name: "Es Teh Manis", price: 5000, fee: 1000, stand: "O-Coffee Stand" },
    { id:4, name: "Ayam Goreng", price: 22000, fee: 2000, stand: "Dapur Mamah" }
];

let orders = []; 

// --- DATA PASSWORD STAFF ---
const staffCredentials = {
    admin: "admin123", // Password untuk Admin
    kasir: "kasir123", // Password untuk Kasir
    stand: "stand123"  // Password untuk Stand
};

io.on('connection', (socket) => {
    
    // --- FITUR LOGIN STAFF ---
    socket.on('attempt_staff_login', (data) => {
        // Cek apakah password yang dimasukkan cocok dengan database server
        if (staffCredentials[data.role] === data.password) {
            socket.emit('staff_login_result', { success: true, role: data.role });
        } else {
            socket.emit('staff_login_result', { success: false, message: "Password salah!" });
        }
    }); 
    socket.on('submit_order', (clientData) => {
        let validatedItems = [];
        let subtotal = 0;

        clientData.items.forEach(clientItem => {
            const original = officialMenu.find(m => m.name === clientItem.name);
            if (original) {
                // Ambil qty dari pesanan HP (default 1 jika kosong)
                const qty = clientItem.qty || 1; 
                // Kalikan dengan harga total item
                const itemTotal = (original.price + original.fee) * qty; 
                const noteText = clientItem.note || "";

                validatedItems.push({
                    name: original.name,
                    qty: qty, // Simpan qty ke database
                    total: itemTotal,
                    stand: original.stand,
                    note: noteText
                });
                subtotal += itemTotal;
            }
        });

        // --- PAJAK SUDAH FIX 10% ---
        const ppn = subtotal * 0.10; 
        const grandTotal = subtotal + ppn;

        const finalOrder = {
            id: clientData.id,
            user: clientData.user,
            table: clientData.table,
            items: validatedItems,
            subtotal: subtotal,
            ppn: ppn,
            total: grandTotal,
            status: 'WAITING_PAYMENT',
            time: new Date().toLocaleTimeString('id-ID')
        };

        orders.push(finalOrder);
        io.emit('new_order_to_cashier', finalOrder);
        io.emit('admin_update', calculateStats());
    });

    socket.on('confirm_payment', (orderId) => {
        let order = orders.find(o => o.id === orderId);
        if (order) {
            order.status = 'PAID';
            io.emit('order_paid_broadcast', order);
            io.emit('admin_update', calculateStats());
        }
    });

    socket.on('get_admin_stats', () => {
        socket.emit('admin_update', calculateStats());
    });
});

function calculateStats() {
    let stats = { totalSales: 0, paidOrders: 0, standRevenue: {}, topItems: {} };
    orders.filter(o => o.status === 'PAID').forEach(o => {
        stats.totalSales += o.total;
        stats.paidOrders++;
        o.items.forEach(item => {
            stats.standRevenue[item.stand] = (stats.standRevenue[item.stand] || 0) + item.total;
            stats.topItems[item.name] = (stats.topItems[item.name] || 0) + item.qty; // Update admin stats sesuai qty
        });
    });
    return stats;
}

http.listen(PORT, () => {
    console.log(`POS System Secure & Online on port ${PORT}`);
});