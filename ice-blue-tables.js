/* Add mobile column labels to dynamic tables without altering desktop semantics. */
(() => {
  'use strict';
  const root = document.querySelector('#page');
  if (!root) return;
  const annotate = () => {
    for (const table of document.querySelectorAll('.data-table')) {
      const labels = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
      for (const row of table.querySelectorAll('tbody tr')) {
        [...row.querySelectorAll('td')].forEach((cell, i) => {
          if (!cell.hasAttribute('colspan')) cell.dataset.label = labels[i] || '';
        });
      }
    }
  };
  annotate();
  new MutationObserver(annotate).observe(root, {subtree:true, childList:true});
})();