'use strict';
(function(root) {
  function initial() {return {view:'targets',target:null,session:null};}
  function change(state,action) {
    switch(action.type) {
      case 'sessions': return {...state,view:'sessions'};
      case 'session': return {...state,session:action.session||null,target:null,view:'targets'};
      case 'target': return {...state,target:action.target,view:'modes'};
      case 'back': return {...state,target:null,view:'targets'};
      default: return state;
    }
  }
  function beside(pet,area,width,height,gap=8,cursor=null) {
    const near=cursor&&cursor.x>=pet.x-width-64&&cursor.x<=pet.x+pet.width+width+64&&cursor.y>=pet.y-180&&cursor.y<=pet.y+pet.height+180;
    let left=pet.x+pet.width/2>=area.x+area.width/2;
    if(near&&cursor.x<pet.x)left=true;
    else if(near&&cursor.x>pet.x+pet.width)left=false;
    if(left&&pet.x-width-gap<area.x+gap)left=false;
    if(!left&&pet.x+pet.width+width+gap>area.x+area.width-gap)left=true;
    const x=left?pet.x-width-gap:pet.x+pet.width+gap;
    const y=near?cursor.y-110:pet.y;
    return {x:Math.round(Math.max(area.x+gap,Math.min(x,area.x+area.width-width-gap))),y:Math.round(Math.max(area.y+gap,Math.min(y,area.y+area.height-height-gap)))};
  }
  const api={initial,change,beside};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.TransferFlow=api;
})(typeof globalThis==='object'?globalThis:this);
