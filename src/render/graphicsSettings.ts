export type DetailLevel = "low" | "medium" | "high";
export type AntiAliasing = "off" | "fxaa" | "msaa+fxaa";
export interface GraphicsSettings {
  renderScale:number;
  antiAliasing:AntiAliasing;
  shadows:boolean;
  particles:number;
  fish:number;
  terrainDetail:DetailLevel;
  modelDetail:DetailLevel;
  postprocessing:boolean;
  sonarEffects:boolean;
  sedimentEffects:boolean;
  labelDistance:number;
}
export const GRAPHICS_PRESETS:Record<"low"|"medium"|"high",GraphicsSettings>={low:{renderScale:1,antiAliasing:"fxaa",shadows:false,particles:.35,fish:.15,terrainDetail:"low",modelDetail:"low",postprocessing:false,sonarEffects:true,sedimentEffects:false,labelDistance:850},medium:{renderScale:1.5,antiAliasing:"msaa+fxaa",shadows:false,particles:.7,fish:.65,terrainDetail:"medium",modelDetail:"medium",postprocessing:true,sonarEffects:true,sedimentEffects:true,labelDistance:1500},high:{renderScale:2,antiAliasing:"msaa+fxaa",shadows:true,particles:1,fish:1,terrainDetail:"high",modelDetail:"high",postprocessing:true,sonarEffects:true,sedimentEffects:true,labelDistance:2200}};
export function validateGraphics(raw:Partial<GraphicsSettings>|null|undefined,fallback=GRAPHICS_PRESETS.medium):GraphicsSettings{const x={...fallback,...raw};return{renderScale:Math.max(.75,Math.min(2,Number.isFinite(x.renderScale)?x.renderScale:fallback.renderScale)),antiAliasing:["off","fxaa","msaa+fxaa"].includes(x.antiAliasing)?x.antiAliasing:fallback.antiAliasing,shadows:!!x.shadows,particles:Math.max(0,Math.min(1,Number.isFinite(x.particles)?x.particles:fallback.particles)),fish:Math.max(0,Math.min(1,Number.isFinite(x.fish)?x.fish:fallback.fish)),terrainDetail:["low","medium","high"].includes(x.terrainDetail)?x.terrainDetail:fallback.terrainDetail,modelDetail:["low","medium","high"].includes(x.modelDetail)?x.modelDetail:fallback.modelDetail,postprocessing:!!x.postprocessing,sonarEffects:!!x.sonarEffects,sedimentEffects:!!x.sedimentEffects,labelDistance:Math.max(300,Math.min(3000,Number.isFinite(x.labelDistance)?x.labelDistance:fallback.labelDistance))};}
