import { Game } from "./game";

async function boot() {
  const canvas = document.getElementById("scene") as HTMLCanvasElement;
  const hud = document.getElementById("hud") as HTMLElement;
  const menus = document.getElementById("menus") as HTMLElement;

  // WebGL2 availability check
  const test = document.createElement("canvas");
  const gl = test.getContext("webgl2");
  if (!gl) {
    document.getElementById("webgl-error")!.classList.remove("hidden");
    return;
  }

  try { const game = new Game(canvas, hud, menus); await game.whenReady();if(new URLSearchParams(location.search).has("memoryAudit")){const target=window as Window&{__abyssMemoryDiagnostics?:()=>ReturnType<Game["memoryDiagnostics"]>;__abyssMemoryAdvance?:(seconds:number)=>ReturnType<Game["memoryDiagnostics"]>};target.__abyssMemoryDiagnostics=()=>game.memoryDiagnostics();target.__abyssMemoryAdvance=seconds=>game.advanceMemoryAudit(seconds);} game.start(); }
  catch(error){console.error("Boot failed",error);document.getElementById("webgl-error")!.classList.remove("hidden");}
}

void boot();
window.addEventListener("unhandledrejection",event=>{console.error("Unhandled rejection",event.reason);document.getElementById("webgl-error")?.classList.remove("hidden");});
