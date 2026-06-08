require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const multer = require('multer');
const db = require('./db');
const app = express();
const officeparser = require('officeparser');

// 文件上传配置
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, Date.now() + '-' + name);
  }
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- 资料 API ---
app.get('/api/materials', (req, res) => {
  const { q } = req.query;
  let rows;
  if (q) {
    rows = db.prepare("SELECT * FROM materials WHERE title LIKE ? OR content LIKE ? OR category LIKE ? ORDER BY created_at DESC")
      .all(`%${q}%`, `%${q}%`, `%${q}%`);
  } else {
    rows = db.prepare('SELECT * FROM materials ORDER BY created_at DESC').all();
  }
  res.json(rows);
});

app.post('/api/materials', (req, res) => {
  const { title, category, content } = req.body;
  const result = db.prepare('INSERT INTO materials (title, category, content) VALUES (?, ?, ?)').run(title, category || '未分类', content);
  res.json({ id: result.lastInsertRowid });
});

app.delete('/api/materials/:id', (req, res) => {
  db.prepare('DELETE FROM materials WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- 文件上传 API ---
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '没有文件' });
  const filename = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  
  let content = `[已上传文件] ${filename}`;
  const ext = filename.toLowerCase().split('.').pop();
  
  // 支持 PDF、Word、PPT、Excel
  if (['pdf', 'docx', 'pptx', 'xlsx', 'odt', 'odp'].includes(ext)) {
    try {
      const parsed = await officeparser.parseOffice(req.file.path);
      // 递归提取所有文字
      function extractText(obj) {
        if (typeof obj === 'string') return obj;
        if (Array.isArray(obj)) return obj.map(extractText).join('');
        if (obj && typeof obj === 'object') {
          if (obj.text) return obj.text;
          if (obj.children) return extractText(obj.children);
          if (obj.pages) return extractText(obj.pages);
        }
        return '';
      }
      content = extractText(parsed).replace(/\n{3,}/g, '\n\n').slice(0, 50000);
    } catch (err) {
      content = `[解析失败] ${filename}: ${err.message}`;
    }
  }
  
  const result = db.prepare('INSERT INTO materials (title, category, content) VALUES (?, ?, ?)')
    .run(filename, '文件', content);
  res.json({ id: result.lastInsertRowid, filename });
});

// --- AI 对话 API ---
app.post('/api/chat', async (req, res) => {
  const { message } = req.body;
  try {
    // 搜索相关资料作为上下文
    // 拆关键词搜索资料库
    const keywords = message.replace(/[？?！!，。、的了吗呢吧是什么怎么有没有关于里面讲]/g, ' ').trim().split(/\s+/).filter(w => w.length >= 2);
    let docs = [];
    if (keywords.length > 0) {
      const conditions = keywords.map(() => '(title LIKE ? OR content LIKE ?)').join(' OR ');
      const params = keywords.flatMap(k => [`%${k}%`, `%${k}%`]);
      docs = db.prepare(`SELECT title, content FROM materials WHERE ${conditions} LIMIT 3`).all(...params);
    }
    const context = docs.length > 0
      ? `以下是用户资料库中的相关内容：\n${docs.map(d => `【${d.title}】${d.content || ''}`).join('\n')}\n\n请结合以上资料回答用户问题。`
      : '';

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-reasoner',
        messages: [
          { role: 'system', content: `你是 Halcyon 的个人AI助手，简洁友好地回答问题。${context}` },
          { role: 'user', content: message }
        ]
      })
    });
    const data = await response.json();
    res.json({ reply: data.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ reply: '出错了: ' + err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`服务器跑起来了: http://localhost:${PORT}`);
});