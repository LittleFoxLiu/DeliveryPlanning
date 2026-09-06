type RuntimeEnv = { VITE_SUPABASE_URL?: string; VITE_SUPABASE_ANON_KEY?: string };

const runtimeEnv = (import.meta as ImportMeta & { env?: RuntimeEnv }).env ?? {};

export const supabaseEnv = {
  url: runtimeEnv.VITE_SUPABASE_URL?.trim() ?? '',
  anonKey: runtimeEnv.VITE_SUPABASE_ANON_KEY?.trim() ?? ''
};
