import type { ActionId } from "./actions";

export interface GamepadLike {axes:readonly number[];buttons:readonly {pressed:boolean;value:number}[];}
export interface GamepadFrame {pressed:Set<ActionId|"selectPrevious"|"selectNext"|"menuActivate"|"menuBack"|"menuPrevious"|"menuNext">;held:Set<ActionId>;camera:{x:number;y:number};}
const deadzone=(value:number,threshold=.18)=>Math.abs(value)<threshold?0:Math.sign(value)*(Math.abs(value)-threshold)/(1-threshold);
export class GamepadInput {
  private previous:boolean[]=[];
  sample(pad:GamepadLike|null,menu=false):GamepadFrame {
    const pressed=new Set<GamepadFrame["pressed"] extends Set<infer T>?T:never>(),held=new Set<ActionId>();
    if(!pad){this.previous=[];return{pressed,held,camera:{x:0,y:0}};}
    const down=(index:number)=>!!pad.buttons[index]?.pressed||pad.buttons[index]?.value>.55;
    const edge=(index:number)=>down(index)&&!this.previous[index];
    if(menu){if(edge(0))pressed.add("menuActivate");if(edge(1)||edge(9))pressed.add("menuBack");if(edge(12)||edge(14))pressed.add("menuPrevious");if(edge(13)||edge(15))pressed.add("menuNext");}
    else {
      if(edge(0))pressed.add("sonar");if(edge(1))pressed.add("manual");if(edge(2))pressed.add("countermeasure");if(edge(3))pressed.add("camera");
      if(edge(4))pressed.add("selectPrevious");if(edge(5))pressed.add("selectNext");if(edge(8))pressed.add("help");if(edge(9))pressed.add("pause");if(edge(10))pressed.add("roleAction");
      const steer=deadzone(pad.axes[0]??0),throttle=-deadzone(pad.axes[1]??0);
      if(steer<0)held.add("steerLeft");if(steer>0)held.add("steerRight");if(throttle>0)held.add("throttleUp");if(throttle<0)held.add("throttleDown");
      if(down(6))held.add("descend");if(down(7))held.add("ascend");
    }
    this.previous=pad.buttons.map(button=>button.pressed||button.value>.55);
    return{pressed,held,camera:{x:deadzone(pad.axes[2]??0),y:deadzone(pad.axes[3]??0)}};
  }
}
