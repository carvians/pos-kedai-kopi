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

// SCHEMA MENU
const menuSchema = new mongoose.Schema({
    name: String, price: Number, fee: Number, cat: String, img: String, stand: String
});
const Menu = mongoose.model('Menu', menuSchema);

// SCHEMA PESANAN (Ditambah processedBy)
const orderSchema = new mongoose.Schema({
    id: String, user: String, table: String, items: Array, subtotal: Number,
    ppn: Number, total: Number, status: String, time: String, completedStands: Array,
    processedBy: String 
});
const Order = mongoose.model('Order', orderSchema);

// SCHEMA STAFF (Ditambah username)
const staffSchema = new mongoose.Schema({ username: { type: String, unique: true }, role: String, password: String });
const Staff = mongoose.model('Staff', staffSchema);

// SCHEMA AKUN STAND
const standAccountSchema = new mongoose.Schema({
    name: { type: String, unique: true },
    password: String
});
const StandAccount = mongoose.model('StandAccount', standAccountSchema);

async function initDatabase() {
    if (await Staff.countDocuments() === 0) {
        // Buat akun default agar tetap bisa login
        await Staff.insertMany([
            { username: "admin_pusat", role: "admin", password: "admin123" }, 
            { username: "kasir_utama", role: "kasir", password: "kasir123" }
        ]);
    }
    console.log('🚀 Semua data di MongoDB siap digunakan!');
}

app.use(express.static(path.join(__dirname, '/')));
app.use(express.json());

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/:page.html', (req, res) => res.sendFile(path.join(__dirname, req.params.page + '.html')));

// --- BUKU TAMU UNTUK MELACAK SIAPA YANG ONLINE ---
const onlineStaff = new Map(); // Menyimpan data: socket.id -> username

io.on('connection', (socket) => {
    
    // --- 1. FITUR BARU: PELACAK STATUS ONLINE ---
    socket.on('staff_connected', (username) => {
        if(username) {
            onlineStaff.set(socket.id, username);
            io.emit('staff_list_updated'); // Beritahu admin ada yang online
        }
    });

    socket.on('disconnect', () => {
        if (onlineStaff.has(socket.id)) {
            onlineStaff.delete(socket.id);
            io.emit('staff_list_updated'); // Beritahu admin ada yang offline
        }
    });

    // --- FITUR BARU: AMBIL & HAPUS AKUN STAFF ---
    socket.on('get_staff_accounts', async () => {
        const staffs = await Staff.find({}, '-password'); 
        const onlineUsernames = Array.from(onlineStaff.values()); 
        
        // Gabungkan data dari database dengan status online saat ini
        const staffList = staffs.map(s => ({
            username: s.username,
            role: s.role,
            isOnline: onlineUsernames.includes(s.username)
        }));
        
        socket.emit('receive_staff_accounts', staffList);
    });

    socket.on('admin_delete_staff', async (username) => {
        if(username === 'admin_pusat') return; 
        await Staff.findOneAndDelete({ username });
        io.emit('staff_list_updated');
    });

    // --- LOGIN STAFF ---
    socket.on('attempt_staff_login', async (data) => {
        // Cek login pakai username atau role lama
        let query = { password: data.password };
        if (data.username) query.username = data.username;
        else query.role = data.role;

        const staff = await Staff.findOne(query);
        if (staff) {
            socket.emit('staff_login_result', { success: true, role: staff.role, username: staff.username });
        } else {
            socket.emit('staff_login_result', { success: false, message: "Password / Akun salah!" });
        }
    }); 

    // --- TAMBAH / UPDATE AKUN KASIR ---
    socket.on('admin_add_staff', async (data) => {
        try {
            const existing = await Staff.findOne({ username: data.username });
            if (existing) {
                existing.password = data.password;
                existing.role = data.role;
                await existing.save();
                socket.emit('update_status', { success: true, message: `Password akun ${data.username} diperbarui!` });
            } else {
                await new Staff(data).save();
                socket.emit('update_status', { success: true, message: `Akun Staff ${data.username} berhasil dibuat!` });
            }
            io.emit('staff_list_updated'); // PENTING: Refresh list di admin
        } catch (err) {
            socket.emit('update_status', { success: false, message: "Gagal memproses akun staff." });
        }
    });

    // --- MANAJEMEN AKUN STAND ---
    socket.on('admin_create_stand', async (data) => {
        try {
            await new StandAccount(data).save();
            socket.emit('update_status', { success: true, message: `Akun Stand ${data.name} berhasil dibuat!` });
            io.emit('stand_list_updated'); 
        } catch (err) {
            socket.emit('update_status', { success: false, message: "Gagal: Nama stand sudah ada!" });
        }
    });

    socket.on('get_stand_accounts', async () => {
        const stands = await StandAccount.find();
        socket.emit('receive_stand_accounts', stands);
    });

    socket.on('admin_delete_stand', async (standName) => {
        await StandAccount.findOneAndDelete({ name: standName });
        await Menu.deleteMany({ stand: standName }); 
        io.emit('stand_list_updated');
    });

    // --- VERIFIKASI LOGIN STAND (KITCHEN) ---
    socket.on('verify_stand_password', async (data) => {
        const account = await StandAccount.findOne({ name: data.stand, password: data.password });
        socket.emit('verify_result', account ? { success: true, stand: data.stand } : { success: false, message: "Password Salah!" });
    });

    // --- MANAJEMEN MENU ---
    socket.on('get_all_menu', async () => {
        const menus = await Menu.find();
        socket.emit('receive_all_menu', menus);
    });

    socket.on('admin_add_menu', async (menuData) => {
        await new Menu(menuData).save();
        io.emit('menu_updated_broadcast');
    });

    socket.on('admin_delete_menu', async (id) => {
        await Menu.findByIdAndDelete(id);
        io.emit('menu_updated_broadcast');
    });

    // --- TRANSAKSI & STATS ---
    socket.on('submit_order', async (clientData) => {
        const dbMenu = await Menu.find();
        let validatedItems = [], subtotal = 0;
        
        clientData.items.forEach(c => {
            const m = dbMenu.find(item => item.name === c.name);
            if (m) {
                const total = (m.price + m.fee) * c.qty;
                validatedItems.push({ ...c, total, stand: m.stand });
                subtotal += total;
            }
        });

        const final = { 
            ...clientData, 
            items: validatedItems, 
            subtotal, 
            ppn: subtotal * 0.1, 
            total: subtotal * 1.1, 
            status: 'WAITING_PAYMENT', 
            time: new Date().toLocaleString('id-ID', { 
                timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit', year: 'numeric', 
                hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' 
            }).replace(/\//g, '-'),
            completedStands: [] 
        };

        await new Order(final).save();
        io.emit('new_order_to_cashier', final);
    });

    // KONFIRMASI LUNAS KASIR (Ditambah nama kasir)
    socket.on('confirm_payment', async (data) => {
        const id = data.id || data; 
        const cashierName = data.cashierName || 'Auto-System';

        const o = await Order.findOneAndUpdate({ id }, { status: 'PAID', processedBy: cashierName }, { new: true });
        io.emit('order_paid_broadcast', o);
        io.emit('admin_update', await calculateStats());
    });

    socket.on('request_stand_orders', async (name) => {
        const pending = await Order.find({ status: 'PAID', completedStands: { $ne: name }, 'items.stand': name });
        socket.emit('load_stand_orders', pending);
    });

    socket.on('mark_stand_completed', async (data) => {
        await Order.findOneAndUpdate({ id: data.orderId }, { $push: { completedStands: data.stand } });
    });

    socket.on('get_admin_stats', async () => socket.emit('admin_update', await calculateStats()));
});

async function calculateStats() {
    const orders = await Order.find({ status: 'PAID' });
    let stats = { totalSales: 0, paidOrders: 0, standRevenue: {}, topItems: {} };
    orders.forEach(o => {
        stats.totalSales += o.total; stats.paidOrders++;
        o.items.forEach(i => {
            stats.standRevenue[i.stand] = (stats.standRevenue[i.stand] || 0) + i.total;
            stats.topItems[i.name] = (stats.topItems[i.name] || 0) + i.qty;
        });
    });
    return stats;
}

const ExcelJS = require('exceljs');
app.get('/download-report', async (req, res) => {
    try {
        const orders = await Order.find({ status: 'PAID' });
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Laporan Penjualan Detail');

        sheet.columns = [
            { header: 'ID ORDER', key: 'id', width: 15 },
            { header: 'TANGGAL & WAKTU', key: 'time', width: 25 },
            { header: 'NAMA PELANGGAN', key: 'user', width: 20 },
            { header: 'MEJA', key: 'table', width: 10 },
            { header: 'NAMA STAND', key: 'stand', width: 20 },
            { header: 'MENU DIPESAN', key: 'menu', width: 25 },
            { header: 'QTY', key: 'qty', width: 8 },
            { header: 'HARGA TOTAL (INC. FEE)', key: 'total_item', width: 20 },
            { header: 'KASIR (PENERIMA)', key: 'processedBy', width: 20 }, // KOLOM KASIR BARU
        ];

        sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
        sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '3d2b1f' } };

        orders.forEach(o => {
            o.items.forEach(item => {
                sheet.addRow({
                    id: o.id, time: o.time, user: o.user, table: o.table,
                    stand: item.stand, menu: item.name, qty: item.qty, total_item: item.total,
                    processedBy: o.processedBy || "Kasir Lama/Default" // Tampilkan nama kasir
                });
            });
        });

        sheet.getColumn(8).numFmt = '"Rp"#,##0';

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=Laporan_Detail_${new Date().toLocaleDateString('id-ID')}.xlsx`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (err) {
        console.error("Excel Error:", err);
        res.status(500).send("Gagal mengunduh laporan detail.");
    }
});

http.listen(PORT, () => console.log(`POS System Secure on port ${PORT}`));