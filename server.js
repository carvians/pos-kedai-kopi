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

// SCHEMA PESANAN
const orderSchema = new mongoose.Schema({
    id: String, user: String, table: String, items: Array, subtotal: Number,
    ppn: Number, total: Number, status: String, time: String, completedStands: Array
});
const Order = mongoose.model('Order', orderSchema);

// SCHEMA STAFF (Admin/Kasir)
const staffSchema = new mongoose.Schema({ role: String, password: String });
const Staff = mongoose.model('Staff', staffSchema);

// SCHEMA AKUN STAND (Baru!)
const standAccountSchema = new mongoose.Schema({
    name: { type: String, unique: true },
    password: String
});
const StandAccount = mongoose.model('StandAccount', standAccountSchema);

async function initDatabase() {
    if (await Staff.countDocuments() === 0) {
        await Staff.insertMany([{ role: "admin", password: "admin123" }, { role: "kasir", password: "kasir123" }]);
    }
    console.log('🚀 Semua data di MongoDB siap digunakan!');
}

app.use(express.static(path.join(__dirname, '/')));
app.use(express.json());

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/:page.html', (req, res) => res.sendFile(path.join(__dirname, req.params.page + '.html')));

io.on('connection', (socket) => {
    
    // --- LOGIN STAFF (ADMIN/KASIR) ---
    socket.on('attempt_staff_login', async (data) => {
        const staff = await Staff.findOne({ role: data.role, password: data.password });
        socket.emit('staff_login_result', staff ? { success: true, role: data.role } : { success: false, message: "Password salah!" });
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
        await Menu.deleteMany({ stand: standName }); // Hapus juga menu miliknya
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
            // --- BAGIAN YANG DIUBAH: PAKSA KE WIB ---
            time: new Date().toLocaleTimeString('id-ID', { 
                timeZone: 'Asia/Jakarta', 
                hour12: false, 
                hour: '2-digit', 
                minute: '2-digit', 
                second: '2-digit' 
            }), 
            completedStands: [] 
        };

        await new Order(final).save();
        io.emit('new_order_to_cashier', final);
    });

    socket.on('confirm_payment', async (id) => {
        const o = await Order.findOneAndUpdate({ id }, { status: 'PAID' }, { new: true });
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
        const wb = new ExcelJS.Workbook();
        const sheet = wb.addWorksheet('Laporan');
        sheet.columns = [{header:'ID',key:'id'}, {header:'Pelanggan',key:'user'}, {header:'Total',key:'total'}];
        orders.forEach(o => sheet.addRow(o));
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=Laporan.xlsx');
        await wb.xlsx.write(res); res.end();
    } catch (e) { res.status(500).send("Gagal"); }
});

http.listen(PORT, () => console.log(`POS System Secure on port ${PORT}`));