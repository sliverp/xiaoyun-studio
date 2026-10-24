import { EventEmitter } from 'node:events'
export class Events extends EventEmitter {
 constructor(){super();this.setMaxListeners(100);this.seq=0;this.history=[]}
 publish(type,payload){const event={id:++this.seq,type,payload,at:Date.now()};if(type!=='meter'){this.history.push(event);if(this.history.length>100)this.history.shift()}this.emit('event',event);return event}
 snapshot(){return this.getSnapshot?.()||{}}
}
