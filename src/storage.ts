import { AppState } from './types'; import { seedState, buildRoadGrid } from './data'; import { supabaseEnv } from './env';
const STATE_KEY='routepilot-demo-state-v1';
export function loadState():AppState { try { const stored=JSON.parse(localStorage.getItem(STATE_KEY)||'null'); return stored ? {...stored,roads:stored.roads||buildRoadGrid()} : structuredClone(seedState); } catch { return structuredClone(seedState); } }
export function saveState(state:AppState):void { try { localStorage.setItem(STATE_KEY,JSON.stringify(state)); } catch {} }
export function saveConfig(url:string,anonKey:string):void { try { localStorage.setItem('routepilot-supabase-config-v1',JSON.stringify({url:url.replace(/\/$/,''),anonKey})); } catch {} }
export function loadConfig():{url?:string;anonKey?:string} { if (supabaseEnv.url && supabaseEnv.anonKey) return supabaseEnv; try { return JSON.parse(localStorage.getItem('routepilot-supabase-config-v1')||'{}'); } catch { return {}; } }
