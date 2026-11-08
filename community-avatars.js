/* KLAR COMMUNITY curated vector avatar illustrations: no uploads or external images. */
window.KlarAvatars = (() => {
  const items = [
    ['bull_trader','Bull Trader','Trading','🐂'],
    ['bear_trader','Bear Trader','Trading','🐻'],
    ['candlestick','Candlestick','Trading','📊'],
    ['diamond_hands','Diamond Hands','Trading','💎'],
    ['trading_legend','Trading Legend','Trading','🏆'],
    ['breakout_king','Breakout King','Trading','📈'],
    ['viking','Viking','Legends','🛡️'],
    ['shield','Shield','Legends','🏅'],
    ['star','Star','Legends','⭐'],
    ['owl','Owl','Djur','🦉'],
    ['fox','Fox','Djur','🦊'],
    ['bear','Bear','Djur','🐻'],
    ['wolf','Wolf','Djur','🐺'],
    ['eagle','Eagle','Djur','🦅']
  ];
  const shapes = {
    bull_trader:'<path d="M26 40 12 19l5 26M74 40l14-21-5 26" fill="#d7a74c" stroke="#f7d98a" stroke-width="3"/><path d="M22 46q3-25 28-24t28 24L70 75 50 84 30 75Z" fill="#b77b32" stroke="#ffe4a2" stroke-width="3"/><path d="m31 51 14 5-10 6m34-11-14 5 10 6" stroke="#061827" stroke-width="5" fill="none"/><path d="M43 67h14l-7 10Z" fill="#ffe5aa"/>',
    bear_trader:'<circle cx="25" cy="28" r="13" fill="#b76b58"/><circle cx="75" cy="28" r="13" fill="#b76b58"/><path d="M17 48q0-28 33-29t33 29L73 76 50 85 27 76Z" fill="#ab504c" stroke="#ffc3a2" stroke-width="3"/><path d="m28 50 16 5m28-5-16 5" stroke="#071826" stroke-width="5"/><ellipse cx="50" cy="66" rx="12" ry="9" fill="#e9a88c"/><path d="M45 63h10l-5 7Z" fill="#071826"/>',
    candlestick:'<path d="M20 76V22m20 56V13m20 65V27m20 47V16" stroke="#8bc5db" stroke-width="4"/><rect x="13" y="42" width="14" height="25" rx="2" fill="#ed6478"/><rect x="33" y="27" width="14" height="34" rx="2" fill="#35e2ae"/><rect x="53" y="45" width="14" height="22" rx="2" fill="#ed6478"/><rect x="73" y="25" width="14" height="34" rx="2" fill="#35e2ae"/>',
    diamond_hands:'<path d="M16 43 32 22h36l16 21-34 39Z" fill="#51c7e8" stroke="#dcf9ff" stroke-width="3"/><path d="M16 43h68M32 22l-5 21 23 39 23-39-5-21M50 22l-9 21 9 39 9-39Z" fill="none" stroke="#eaffff" stroke-width="2"/>',
    trading_legend:'<path d="M31 21h38v23q0 23-19 27-19-4-19-27Z" fill="#e6b651" stroke="#fff0b0" stroke-width="3"/><path d="M31 28H18q-2 24 18 25m33-25h13q2 24-18 25" fill="none" stroke="#e6b651" stroke-width="6"/><path d="M50 30 55 42l13 1-10 8 3 13-11-7-11 7 3-13-10-8 13-1Z" fill="#fff3bd"/><path d="M50 72v9m-16 3h32" stroke="#fff0b0" stroke-width="6"/>',
    breakout_king:'<path d="M16 76h68M20 70l18-17 13 7 28-33" stroke="#35e2ae" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M62 27h17v17" stroke="#35e2ae" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M17 35h40" stroke="#e7c475" stroke-width="3" stroke-dasharray="5 5"/>'
  };
  function svg(key) {
    const info=items.find(item=>item[0]===key)||items[6];
    const trading=info[2]==='Trading';
    const art=shapes[key] || '<text x="50" y="66" font-size="51" text-anchor="middle">'+info[3]+'</text>';
    const markup='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="'+info[1]+'"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#183c57"/><stop offset="1" stop-color="#071826"/></linearGradient></defs><rect width="100" height="100" rx="18" fill="url(#bg)"/><rect x="4" y="4" width="92" height="92" rx="15" fill="none" stroke="'+(trading?'#cfa955':'#507b91')+'" stroke-width="3"/><path d="M12 87h76" stroke="#b9954e" stroke-width="2" opacity=".6"/>'+art+'</svg>';
    return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(markup);
  }
  return {items,svg};
})();