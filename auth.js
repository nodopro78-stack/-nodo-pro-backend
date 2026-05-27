import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    let user = null;

    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const { data, error } = await supabase.auth.getUser(token);
      if (!error && data?.user) {
        user = { id: data.user.id, email: data.user.email };
      }
    }

    // Modo prueba: si no hay token, usa el usuario de prueba del .env
    if (!user) {
      user = {
        id: process.env.SUPABASE_TEST_USER_ID || '00000000-0000-0000-0000-000000000000',
        email: process.env.SUPABASE_TEST_USER_EMAIL || 'test@nodopro.com'
      };
    }

    req.user = user;
    next();
  } catch (err) {
    req.user = {
      id: process.env.SUPABASE_TEST_USER_ID || '00000000-0000-0000-0000-000000000000',
      email: process.env.SUPABASE_TEST_USER_EMAIL || 'test@nodopro.com'
    };
    next();
  }
}

export default { authenticate };
