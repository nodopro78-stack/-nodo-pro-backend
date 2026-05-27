import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import multer from 'multer';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const upload = multer({ storage: multer.memoryStorage() });

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'nodo-pro-backend' });
});

app.post('/api/upload/:bucket', upload.single('file'), async (req, res) => {
  const bucket = req.params.bucket;
  const file = req.file;
  const filename = Date.now() + '-' + file.originalname;
  
  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(filename, file.buffer, { contentType: file.mimetype });
  
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, path: data.path });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor listo'));
