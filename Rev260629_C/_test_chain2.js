// Test: does the nested template literal with IIFE generate correct button classes?
const t1 = { id: 1, deps: [2], next: [], title: 'has deps' };
const t2 = { id: 2, deps: [], next: [1], title: 'has next' };
const t3 = { id: 3, deps: [], next: [], title: 'no chain' };

function makeBtn(t) {
  return `${(() => { const hasChain = (t.deps && t.deps.length > 0) || (t.next && t.next.length > 0); return `<button class="row-action-btn add-btn chain-add ${hasChain ? 'chain-has' : 'chain-empty'}" onclick="showTaskChain(${t.id})">📋 任务链</button>`; })()}`;
}

console.log('t1 (has deps):', makeBtn(t1));
console.log('t2 (has next):', makeBtn(t2));
console.log('t3 (no chain):', makeBtn(t3));

// Verify
const b1 = makeBtn(t1);
const b2 = makeBtn(t2);
const b3 = makeBtn(t3);

console.log('\n--- Verification ---');
console.log('t1 has chain-has:', b1.includes('chain-has') && !b1.includes('chain-empty') ? 'PASS' : 'FAIL');
console.log('t2 has chain-has:', b2.includes('chain-has') && !b2.includes('chain-empty') ? 'PASS' : 'FAIL');
console.log('t3 has chain-empty:', b3.includes('chain-empty') && !b3.includes('chain-has') ? 'PASS' : 'FAIL');
