require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const mongoose = require('mongoose');
const PORT = process.env.PORT || 3000; 

mongoose.connect(process.env.MONGO_URL)
    .then(() => {
        console.log('✅ Database MongoDB Berhasil Terhubung!');
        initDatabase();
    })
    .catch((err) => console.log('❌ Gagal terhubung ke MongoDB:', err));

const menuSchema = new mongoose.Schema({
    name: String,
    price: Number,
    fee: Number,
    cat: String,
    img: String,
    stand: String
});
const Menu = mongoose.model('Menu', menuSchema);

const orderSchema = new mongoose.Schema({
    id: String,
    user: String,
    table: String,
    items: Array,
    subtotal: Number,
    ppn: Number,
    total: Number,
    status: String,
    time: String,
    completedStands: Array
});
const Order = mongoose.model('Order', orderSchema);

const staffSchema = new mongoose.Schema({
    role: String,
    password: String
});
const Staff = mongoose.model('Staff', staffSchema);

let orders = []; // RAM Backup agar real-time tetap ngebut

async function initDatabase() {
    const menuCount = await Menu.countDocuments();
    if (menuCount === 0) {
        console.log('📦 Memasukkan data menu default ke database...');
        await Menu.insertMany([
            { name: "Iced Latte", price: 25000, fee: 2000, cat: "minuman", img: "https://images.unsplash.com/photo-1541167760496-162955ed8a9f?w=200", stand: "O-Coffee Stand" },
            { name: "Nasi Goreng Special", price: 30000, fee: 3000, cat: "makanan", img: "https://images.unsplash.com/photo-1512058560566-427a1bd5a560?w=200", stand: "Dapur Mamah" },
            { name: "Es Teh Manis", price: 5000, fee: 1000, cat: "minuman", img: "https://images.unsplash.com/photo-1556679343-c7306c1976bc?w=200", stand: "O-Coffee Stand" },
            { name: "Ayam Goreng", price: 22000, fee: 2000, cat: "makanan", img: "https://images.unsplash.com/photo-1562967914-608f82629710?w=200", stand: "Dapur Mamah" }
        ]);
    }

    const staffCount = await Staff.countDocuments();
    if (staffCount === 0) {
        console.log('🔐 Membuat akun staff default...');
        await Staff.insertMany([
            { role: "admin", password: "admin123" },
            { role: "kasir", password: "kasir123" },
            { role: "stand", password: "stand123" }
        ]);
    }

    // Tarik rekapan pesanan dari database ke memori (RAM) saat server nyala
    orders = await Order.find();
    console.log('🚀 Semua data di MongoDB siap digunakan!');
}

app.use(express.static(path.join(__dirname, '/')));
app.use(express.json());

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/:page.html', (req, res) => {
    res.sendFile(path.join(__dirname, req.params.page + '.html'));
});

io.on('connection', (socket) => {
    
    // --- FITUR HAPUS MENU ---
    socket.on('admin_delete_menu', async (id) => {
        await Menu.findByIdAndDelete(id);
        io.emit('menu_updated_broadcast'); // Beritahu semua layar untuk update
    });

    // --- FITUR HAPUS SELURUH STAND ---
    // (Akan menghapus semua menu yang terhubung dengan nama stand tersebut)
    socket.on('admin_delete_stand', async (standName) => {
        await Menu.deleteMany({ stand: standName });
        io.emit('menu_updated_broadcast');
    });

    // --- FITUR LOGIN DB ---
    socket.on('attempt_staff_login', async (data) => {
        const staff = await Staff.findOne({ role: data.role, password: data.password });
        if (staff) {
            socket.emit('staff_login_result', { success: true, role: data.role });
        } else {
            socket.emit('staff_login_result', { success: false, message: "Password salah!" });
        }
    }); 

    // --- MENU DINAMIS & CRUD ADMIN ---
    socket.on('get_all_menu', async () => {
        const menus = await Menu.find();
        socket.emit('receive_all_menu', menus);
    });

    socket.on('admin_add_menu', async (menuData) => {
        await new Menu(menuData).save();
        io.emit('menu_updated_broadcast');
    });

    socket.on('admin_update_password', async (data) => {
        await Staff.findOneAndUpdate({ role: data.role }, { password: data.password });
        socket.emit('update_status', { success: true, message: "Password berhasil diganti!" });
    });

    // --- FITUR ORDER (SIMPAN KE DB) ---
    socket.on('submit_order', async (clientData) => {
        const dbMenu = await Menu.find(); // Validasi pakai harga terbaru dari DB
        let validatedItems = [];
        let subtotal = 0;

        clientData.items.forEach(clientItem => {
            const original = dbMenu.find(m => m.name === clientItem.name);
            if (original) {
                const qty = clientItem.qty || 1; 
                const itemTotal = (original.price + original.fee) * qty; 
                const noteText = clientItem.note || "";

                validatedItems.push({
                    name: original.name,
                    qty: qty, 
                    total: itemTotal,
                    stand: original.stand,
                    note: noteText
                });
                subtotal += itemTotal;
            }
        });

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
            time: new Date().toLocaleTimeString('id-ID'),
            completedStands: []
        };

        orders.push(finalOrder); // Simpan di RAM
        await new Order(finalOrder).save(); // Simpan permanen ke MongoDB
        
        io.emit('new_order_to_cashier', finalOrder);
        io.emit('admin_update', calculateStats());
    });

    socket.on('confirm_payment', async (orderId) => {
        let order = orders.find(o => o.id === orderId);
        if (order) {
            order.status = 'PAID';
            await Order.findOneAndUpdate({ id: orderId }, { status: 'PAID' }); // Update di DB
            io.emit('order_paid_broadcast', order);
            io.emit('admin_update', calculateStats());
        }
    });

    socket.on('request_stand_orders', (standName) => {
        const pendingOrders = orders.filter(o => 
            o.status === 'PAID' && 
            !o.completedStands.includes(standName) && 
            o.items.some(i => i.stand === standName)  
        );
        socket.emit('load_stand_orders', pendingOrders);
    });

    socket.on('mark_stand_completed', async (data) => {
        let order = orders.find(o => o.id === data.orderId);
        if (order && !order.completedStands.includes(data.stand)) {
            order.completedStands.push(data.stand); 
            await Order.findOneAndUpdate({ id: data.orderId }, { $push: { completedStands: data.stand } }); // Simpan ke DB
        }
    });

    socket.on('get_admin_stats', async () => {
    const stats = await calculateStats();
    socket.emit('admin_update', stats);
    });
});

async function calculateStats() {
    // Ambil data terbaru langsung dari MongoDB
    const allPaidOrders = await Order.find({ status: 'PAID' });
    
    let stats = { totalSales: 0, paidOrders: 0, standRevenue: {}, topItems: {} };
    
    allPaidOrders.forEach(o => {
        stats.totalSales += o.total;
        stats.paidOrders++;
        o.items.forEach(item => {
            stats.standRevenue[item.stand] = (stats.standRevenue[item.stand] || 0) + item.total;
            stats.topItems[item.name] = (stats.topItems[item.name] || 0) + item.qty; 
        });
    });
    return stats;
}

const ExcelJS = require('exceljs');

app.get('/download-report', async (req, res) => {
    try {
        const orders = await Order.find({ status: 'PAID' });
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Laporan Penjualan');

        sheet.columns = [
            { header: 'ID Order', key: 'id', width: 15 },
            { header: 'Waktu', key: 'time', width: 15 },
            { header: 'Pelanggan', key: 'user', width: 20 },
            { header: 'Meja', key: 'table', width: 10 },
            { header: 'Total Bayar', key: 'total', width: 15 },
        ];

        orders.forEach(o => {
            sheet.addRow({ id: o.id, time: o.time, user: o.user, table: o.table, total: o.total });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=Laporan_POS_KedaiKopi.xlsx');

        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        res.status(500).send("Gagal mengunduh laporan");
    }
});

http.listen(PORT, () => {
    console.log(`POS System Secure & Online on port ${PORT}`);
});