#!/bin/bash
# Watchdog: dam bao beer-pos luon chay (tu restart neu crash / bi OOM kill)
# Da cai dat cron: */5 * * * *

LOG=/var/log/beerpos-watchdog.log
APP=beer-pos

if ! pm2 describe $APP > /dev/null 2>&1; then
  echo "[$(date '+%F %T')] $APP khong ton tai -> restoring tu dump" >> $LOG
  pm2 resurrect >> $LOG 2>&1
  pm2 save >> $LOG 2>&1
  exit 0
fi

STATUS=$(pm2 jlist 2>/dev/null | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{
    const a=JSON.parse(s);const p=a.find(x=>x.name==='$APP');
    console.log(p?p.pm2_env.status:'missing');
  }catch(e){console.log('error');}
});")

if [ "$STATUS" != "online" ]; then
  echo "[$(date '+%F %T')] $APP status=$STATUS -> restart" >> $LOG
  pm2 restart $APP >> $LOG 2>&1
  pm2 save >> $LOG 2>&1
fi

# Restart neu process bi OOM kill (mem vuot 600MB)
MEM=$(pm2 jlist 2>/dev/null | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{
    const a=JSON.parse(s);const p=a.find(x=>x.name==='$APP');
    console.log(p?Math.round(p.monit.memory/1048576):0);
  }catch(e){console.log(0);}
});")

if [ "$MEM" -gt 600 ] 2>/dev/null; then
  echo "[$(date '+%F %T')] $APP mem=${MEM}MB > 600MB -> restart de tranh OOM" >> $LOG
  pm2 restart $APP >> $LOG 2>&1
fi
