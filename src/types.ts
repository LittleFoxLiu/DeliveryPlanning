export type Availability = 'Available' | 'On route' | 'Break';
export type TrafficStatus = 'Clear' | 'Moderate' | 'Heavy';
export type Priority = 'Standard' | 'Express';
export type RoadStatus = 'Clear' | 'Moderate' | 'Heavy' | 'Closed';
export interface TrafficCondition { id:string; area:string; status:TrafficStatus; delay:number; source:string; updated:string; }
export interface CustomerOrder { id:string; customer:string; location:string; zone:string; items:string; delivery:string; priority:Priority; volume:number; status:string; gridX?:number; gridY?:number; }
export interface DriverCondition { id:string; name:string; availability:Availability; load:number; position:string; maxLoad:number; vehicle:string; }
export interface RoadSegment { id:string; startX:number; startY:number; endX:number; endY:number; status:RoadStatus; delay:number; source:string; orientation:'horizontal'|'vertical'; roadGroup:string; }
export interface AppState { traffic:TrafficCondition[]; orders:CustomerOrder[]; drivers:DriverCondition[]; roads:RoadSegment[]; }
export interface Route { id:string; driver:DriverCondition; orders:CustomerOrder[]; distance:number; eta:number; stops:number; fill:number; color:string; }
export interface GraphNode { id:string; type:string; [key:string]:unknown; }
export interface GraphEdge { from:string; to:string; weight:number; blocked:boolean; }
export interface Graph { nodes:GraphNode[]; edges:GraphEdge[]; }
