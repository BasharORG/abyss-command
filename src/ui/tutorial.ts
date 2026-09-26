export type TutorialEvent =
  | "camera-used"
  | "unit-selected"
  | "assignment-opened"
  | "directive-changed"
  | "autonomy-observed"
  | "manual-taken"
  | "manual-returned"
  | "contacts-opened"
  | "obstacle-opened"
  | "network-opened"
  | "defense-opened"
  | "logistics-opened";

export interface TutorialContext {
  playing:boolean;
  selectedUnit:boolean;
  hasAssignments:boolean;
  hasContacts:boolean;
  obstacleRelevant:boolean;
  networkRelevant:boolean;
  defenseRelevant:boolean;
  logisticsRelevant:boolean;
  manualActive:boolean;
}

export interface TutorialStep {id:string;event:TutorialEvent;title:string;instruction:string;target:string;relevant:(context:TutorialContext)=>boolean;}

export const TUTORIAL_STEPS:TutorialStep[]=[
  {id:"contacts",event:"contacts-opened",title:"Inspect uncertain contacts",instruction:"Open Threat Response. Classification comes from accumulated sensor evidence—not perfect information.",target:".cc-threat",relevant:c=>c.hasContacts},
  {id:"obstacles",event:"obstacle-opened",title:"Compare obstacle routes",instruction:"Open Obstacle Navigation and review distance, clearance, compatible hulls, and route status.",target:".cc-trial",relevant:c=>c.obstacleRelevant},
  {id:"network",event:"network-opened",title:"Read the fleet network",instruction:"Open Fleet Network and inspect command paths, latency, data age, relays, and broken links.",target:".cc-network",relevant:c=>c.networkRelevant},
  {id:"defense",event:"defense-opened",title:"Review the defensive plan",instruction:"Open Defensive Operations. Confirm the protected vessel and assigned screen before contact.",target:".cc-defense",relevant:c=>c.defenseRelevant},
  {id:"logistics",event:"logistics-opened",title:"Review readiness and reserves",instruction:"Open Logistics now that readiness has changed. Check reserves, supplies, and repair capacity.",target:".cc-logistics",relevant:c=>c.logisticsRelevant},
  {id:"return",event:"manual-returned",title:"Return control",instruction:"Use Return to NEREUS. The vessel will recover into a fresh assignment without snapping.",target:".manual-helm",relevant:c=>c.manualActive},
  {id:"assignment",event:"assignment-opened",title:"Read NEREUS's assignment",instruction:"Review the selected vessel's task, target, action, and controller response.",target:".unit-detail",relevant:c=>c.hasAssignments&&c.selectedUnit},
  {id:"manual",event:"manual-taken",title:"Take the helm",instruction:"Choose Manual Intervention. NEREUS will continue commanding the other four vessels.",target:".control-mode-bar",relevant:c=>c.playing&&c.selectedUnit},
  {id:"selection",event:"unit-selected",title:"Select a submarine",instruction:"Select any submarine from Fleet Execution or with keys 1–5.",target:".cc-fleet",relevant:c=>c.playing&&!c.selectedUnit},
  {id:"camera",event:"camera-used",title:"Survey the scene",instruction:"Drag the ocean view or use the wheel while NEREUS continues commanding the fleet.",target:"#game-canvas",relevant:c=>c.playing},
  {id:"directives",event:"directive-changed",title:"Constrain the commander",instruction:"Change one Fleet Directive and NEREUS will distribute the new constraint.",target:".cc-directives",relevant:c=>c.playing},
  {id:"autonomy",event:"autonomy-observed",title:"NEREUS has the fleet",instruction:"Watch the live assignments change as NEREUS coordinates all five submarines.",target:".cc-overview",relevant:c=>c.hasAssignments&&!c.manualActive}
];

interface TutorialStorage {getItem(key:string):string|null;setItem(key:string,value:string):void;removeItem(key:string):void;}
export class TutorialController {
  completed=new Set<TutorialEvent>();
  skipped=false;
  constructor(private storage:TutorialStorage=localStorage){try{const saved=JSON.parse(storage.getItem("abyss-tutorial-v2")??"{}");this.completed=new Set(saved.completed??[]);this.skipped=!!saved.skipped;}catch{}}
  private save(){try{this.storage.setItem("abyss-tutorial-v2",JSON.stringify({completed:[...this.completed],skipped:this.skipped}));}catch{}}
  record(event:TutorialEvent){if(this.skipped||this.completed.has(event))return false;this.completed.add(event);this.save();return true;}
  current(context:TutorialContext){if(this.skipped)return null;return TUTORIAL_STEPS.find(step=>!this.completed.has(step.event)&&step.relevant(context))??null;}
  skip(){this.skipped=true;this.save();}
  reset(){this.completed.clear();this.skipped=false;this.storage.removeItem("abyss-tutorial-v2");}
  get progress(){return{done:this.completed.size,total:TUTORIAL_STEPS.length};}
}
