// Replace these placeholders with the values from Supabase Project Settings > API.
// The anon key is safe to expose publicly; RLS policies still control access.
window.SUPABASE_URL = 'https://hyeubekegkvnolzbvxnh.supabase.co';
window.SUPABASE_ANON_KEY = 'sb_publishable_M4vOrMcF_PQAcnhSatSteg_t25kBpCr';

// Keep one shared config shape for the admin authentication and dashboard scripts.
window.SUPABASE_CONFIG = {
    url: window.SUPABASE_URL,
    anonKey: window.SUPABASE_ANON_KEY,
};
