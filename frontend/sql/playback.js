/**
 * playback.js — MySQL Engine Visualizer
 * Mutates state of existing DOM elements ONLY during playback.
 * NO fetch, NO HTML rebuilds, NO container clearing.
 */

(function(exports) {
  'use strict';

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function applyStep(stepIndex, model, domMap, inspector) {
    if (!model || !model.steps || model.steps.length === 0) return;

    const clampedIdx = Math.max(0, Math.min(stepIndex, model.steps.length - 1));
    const step = model.steps[clampedIdx];

    // Log live render details
    console.log('[LIVE RENDER]', {
      stepIndex: clampedIdx,
      totalSteps: model.steps.length,
      counters: step.counters,
      perTableCounters: step.perTableCounters,
      eventType: step.type
    });

    // 1. Update Progress Bar & Pipeline Strip
    if (inspector.progressFill && inspector.stepInfo) {
      const pct = Math.round(((clampedIdx + 1) / model.steps.length) * 100);
      inspector.progressFill.style.width = `${pct}%`;
      inspector.stepInfo.textContent = `Step ${clampedIdx + 1} / ${model.steps.length}`;
    }

    if (domMap && domMap.pipeline) {
      const p = domMap.pipeline;
      Object.values(p).forEach(el => {
        if (el) {
          el.style.background = 'var(--panel-bg)';
          el.style.borderColor = 'var(--card-border)';
          el.style.color = 'var(--text-muted)';
          el.style.boxShadow = 'none';
        }
      });

      let activePipe = null;
      if (step.type === 'SQL_RECEIVED') activePipe = p.sql;
      else if (step.type === 'LEX_PARSE') activePipe = p.parse;
      else if (step.type === 'OPTIMIZER') activePipe = p.optimizer;
      else if (step.type === 'TABLE_ACCESS_START') activePipe = p.access;
      else if (step.type === 'ROW_CURRENT' || step.type === 'FILTER_EVALUATED' || step.type === 'ROW_UPDATED' || step.type === 'ROW_DELETED') activePipe = p.rows;
      else if (step.type === 'ROW_SELECTED' || step.type === 'RESULT_SENT') activePipe = p.result;
      else activePipe = p.storage;

      if (activePipe) {
        activePipe.style.background = '#1a293b';
        activePipe.style.borderColor = 'var(--accent-cyan)';
        activePipe.style.color = 'var(--accent-cyan)';
        activePipe.style.boxShadow = '0 0 8px rgba(6, 182, 212, 0.4)';
      }
    }

    // 2. Update Table Row States & Counters directly from pre-computed step
    if (domMap && step.rowStates) {
      const rIds = Object.keys(step.rowStates);
      rIds.forEach(rId => {
        const rs = step.rowStates[rId];
        let rowObj = domMap.rowElements ? (domMap.rowElements.get(rId) || (rs.compositeKey ? domMap.rowElements.get(rs.compositeKey) : null)) : null;

        if (!rowObj && domMap && domMap.container && rs) {
          const targetAlias = (rs.alias || rs.table || '').toLowerCase();
          const targetTbody = domMap.container.querySelector(`tbody[data-alias="${targetAlias}"], tbody[data-table="${targetAlias}"]`) || domMap.observedTbody;

          if (targetTbody) {
            const existingDataRows = targetTbody.querySelectorAll('tr[id^="rrow-"]');
            const emptyTr = targetTbody.querySelector('#observed-empty-tr, [id^="observed-empty-tr"]');
            const tbodyIsEmpty = existingDataRows.length === 0;

            if (emptyTr) emptyTr.remove();

            if (tbodyIsEmpty) {
              const cKey = rs.compositeKey || rId;
              const tr = document.createElement('tr');
              tr.id = `rrow-${escapeHtml(cKey)}`;
              tr.className = 'row-waiting';
              tr.innerHTML = `
                <td><strong>${escapeHtml(rs.id || rId)}</strong></td>
                <td id="rrow-name-${escapeHtml(cKey)}">${escapeHtml(rs.name)}</td>
                <td class="row-status-cell" id="rrow-status-${escapeHtml(cKey)}">
                  <span style="color: var(--text-muted);">NOT VISITED</span>
                </td>
              `;
              targetTbody.appendChild(tr);
              const statusEl = tr.querySelector(`#rrow-status-${escapeHtml(cKey)}`);
              rowObj = { tr, statusEl };
              if (domMap.rowElements) {
                domMap.rowElements.set(cKey, rowObj);
                domMap.rowElements.set(rId, rowObj);
              }
            }
          }
        }

        if (rowObj && rowObj.tr && rowObj.statusEl) {
          let statusHtml = '<span style="color: var(--text-muted);">NOT VISITED</span>';
          let rowClass = 'row-waiting';

          if (rs.status === 'CURRENT_OUTER') {
            rowClass = 'row-current';
            statusHtml = '<span style="color: var(--accent-cyan); font-weight: 700;">CURRENT OUT ▶</span>';
          } else if (rs.status === 'CURRENT_INNER') {
            rowClass = 'row-current';
            statusHtml = '<span style="color: var(--accent-amber); font-weight: 700;">CURRENT IN ▶</span>';
          } else if (rs.status === 'CURRENT') {
            rowClass = 'row-current';
            statusHtml = '<span>CURRENT ROW ▶</span>';
          } else if (rs.status === 'FILTER_PASSED') {
            rowClass = 'row-matched';
            statusHtml = '<span style="color: var(--accent-amber); font-weight: 700;">FILTER PASSED ✓</span>';
          } else if (rs.status === 'EXAMINED') {
            rowClass = 'row-matched';
            statusHtml = '<span style="color: var(--accent-amber); font-weight: 700;">EXAMINED ✓</span>';
          } else if (rs.status === 'SELECTED') {
            rowClass = 'row-selected';
            statusHtml = '<span>SELECTED ✓</span>';
          } else if (rs.status === 'DISCARDED') {
            rowClass = 'row-discarded';
            statusHtml = '<span>DISCARDED ✕</span>';
          } else if (rs.status === 'UPDATED') {
            rowClass = 'row-matched';
            statusHtml = '<span>UPDATED ✓</span>';
          } else if (rs.status === 'DELETED') {
            rowClass = 'row-deleted';
            statusHtml = '<span>DELETED ✕</span>';
          }

          if (rowObj.tr.className !== rowClass) {
            rowObj.tr.className = rowClass;
          }
          if (rowObj.statusEl.innerHTML !== statusHtml) {
            rowObj.statusEl.innerHTML = statusHtml;
          }
        }
      });

      // Update Join Operator Panel & Join Stream if present
      if (domMap.joinOpOuter && step.activeRowKey) {
        if (step.alias) {
          if (step.stepIndex % 2 === 0) {
            domMap.joinOpOuter.textContent = `${step.alias}:${step.rowKey || step.activeRowKey}`;
          } else {
            domMap.joinOpInner.textContent = `${step.alias}:${step.rowKey || step.activeRowKey}`;
          }
        }
      }

      if (domMap.joinOpComp) {
        if (step.type === 'JOIN_MATCH') {
          domMap.joinOpComp.textContent = step.explanation || 'Join condition evaluated';
          if (domMap.joinOpStatus) {
            domMap.joinOpStatus.innerHTML = step.matched ? '<span style="color: var(--accent-green); font-weight: 700;">MATCH ✓</span>' : '<span style="color: var(--accent-rose); font-weight: 700;">NO MATCH ✕</span>';
          }
        } else if (step.type === 'FILTER_EVALUATED') {
          domMap.joinOpComp.textContent = `Predicate: ${step.condition || ''}`;
          if (domMap.joinOpStatus) {
            domMap.joinOpStatus.innerHTML = step.passed ? '<span style="color: var(--accent-green); font-weight: 700;">FILTER PASS ✓</span>' : '<span style="color: var(--accent-rose); font-weight: 700;">FILTER REJECTED ✕</span>';
          }
        }
      }

      if (domMap.joinStreamTbody && step.resultStream) {
        const stream = step.resultStream || [];
        if (stream.length === 0) {
          domMap.joinStreamTbody.innerHTML = `
            <tr id="join-stream-empty-tr">
              <td colspan="3" style="color: var(--text-muted); font-style: italic;">No joined tuples produced yet...</td>
            </tr>
          `;
        } else {
          let jHtml = '';
          stream.forEach(r => {
            jHtml += `
              <tr>
                <td><strong>#${escapeHtml(r.resultRowSeq || r.id)}</strong></td>
                <td>${escapeHtml(Array.isArray(r.values) ? r.values.join(' | ') : r.name)}</td>
                <td><span style="color: var(--accent-green); font-weight: 700;">PRODUCED ✓</span></td>
              </tr>
            `;
          });
          domMap.joinStreamTbody.innerHTML = jHtml;
        }
      }

      // Dynamic SVG Connection Overlay
      updateJoinSvgOverlay(domMap, step);

      // Update counters directly from step.counters
      if (step.counters) {
        if (domMap.cntExamined) domMap.cntExamined.textContent = step.counters.examined;
        if (domMap.cntSelected) domMap.cntSelected.textContent = step.counters.selected;
        if (domMap.cntDiscarded) domMap.cntDiscarded.textContent = step.counters.discarded;
      }

      // Update per-table counters with robust key matching
      if (step.perTableCounters && domMap.perTableCounters) {
        Object.keys(step.perTableCounters).forEach(tblKey => {
          let elObj = domMap.perTableCounters.get(tblKey);
          if (!elObj) {
            const targetLower = tblKey.toLowerCase();
            for (const [k, element] of domMap.perTableCounters.entries()) {
              if (k.toLowerCase() === targetLower || k.toLowerCase().includes(targetLower) || targetLower.includes(k.toLowerCase())) {
                elObj = element;
                break;
              }
            }
          }
          if (elObj) {
            const cntData = step.perTableCounters[tblKey];
            if (typeof cntData === 'object') {
              if (elObj.examined) elObj.examined.textContent = cntData.examined !== undefined ? cntData.examined : 0;
              if (elObj.selected) elObj.selected.textContent = cntData.selected !== undefined ? cntData.selected : 0;
            } else if (elObj.textContent !== undefined) {
              elObj.textContent = cntData;
            } else if (elObj.examined) {
              elObj.examined.textContent = cntData;
            }
          }
        });
      }

      // Update Client Result Set Stream table from step.resultStream
      if (domMap.resultTbody) {
        const stream = step.resultStream || [];
        if (stream.length === 0) {
          domMap.resultTbody.innerHTML = `
            <tr id="result-empty-tr">
              <td colspan="4" style="color: var(--text-muted); font-style: italic;">No result rows received yet...</td>
            </tr>
          `;
        } else {
          let resHtml = '';
          stream.forEach(r => {
            if (Array.isArray(r.values) && r.values.length > 0) {
              resHtml += '<tr>';
              r.values.forEach(v => {
                resHtml += `<td>${escapeHtml(v)}</td>`;
              });
              resHtml += '</tr>';
            } else {
              resHtml += `
                <tr>
                  <td><strong>${escapeHtml(r.id)}</strong></td>
                  <td colspan="3">${escapeHtml(r.name)}</td>
                </tr>
              `;
            }
          });
          domMap.resultTbody.innerHTML = resHtml;
        }
      }
    }

    // 3. Update Right Inspector Panel
    if (inspector.title && inspector.seq && inspector.eventType && inspector.studentExplanation && inspector.rawJson) {
      inspector.title.textContent = `Event #${step.seq || step.stepIndex + 1}`;
      inspector.seq.textContent = `#${step.seq || step.stepIndex + 1}`;
      inspector.eventType.textContent = step.title || step.type;
      inspector.studentExplanation.textContent = step.explanation || 'Processing query execution step.';
      inspector.rawJson.textContent = JSON.stringify(step.event || {}, null, 2);
    }
  }

  function updateJoinSvgOverlay(domMap, step) {
    if (!domMap || !domMap.joinSvgGroup || !domMap.container) return;
    try {
      domMap.joinSvgGroup.innerHTML = '';
      if (!step) return;

      let outerKey = step.activeRowKey;
      let innerKey = null;

      if (!outerKey && step.alias && step.rowKey) {
        outerKey = `${step.alias}:${step.rowKey}`;
      }

      if (domMap.rowElements) {
        domMap.rowElements.forEach((val, k) => {
          if (k !== outerKey) {
            if (val.tr && (val.tr.classList.contains('row-current') || val.tr.classList.contains('row-matched'))) {
              innerKey = k;
            }
          }
        });
      }

      if (!outerKey || !innerKey) return;

      const sourceObj = domMap.rowElements.get(outerKey);
      const targetObj = domMap.rowElements.get(innerKey);
      if (!sourceObj || !targetObj || !sourceObj.tr || !targetObj.tr) return;

      const containerRect = domMap.container.getBoundingClientRect();
      const rectA = sourceObj.tr.getBoundingClientRect();
      const rectB = targetObj.tr.getBoundingClientRect();

      if (rectA.width === 0 || rectB.width === 0) return;

      const x1 = rectA.right - containerRect.left;
      const y1 = rectA.top + rectA.height / 2 - containerRect.top;
      const x2 = rectB.left - containerRect.left;
      const y2 = rectB.top + rectB.height / 2 - containerRect.top;

      const dx = Math.max(20, Math.abs(x2 - x1) / 2);
      const pathD = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;

      let strokeColor = '#06b6d4';
      let markerId = 'arrow-cyan';

      if (step.type === 'JOIN_MATCH' || step.matched) {
        strokeColor = '#10b981';
        markerId = 'arrow-green';
      } else if (step.type === 'FILTER_EVALUATED' && !step.passed) {
        strokeColor = '#f43f5e';
        markerId = 'arrow-rose';
      }

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', pathD);
      path.setAttribute('stroke', strokeColor);
      path.setAttribute('stroke-width', '2.5');
      path.setAttribute('fill', 'none');
      path.setAttribute('marker-end', `url(#${markerId})`);

      domMap.joinSvgGroup.appendChild(path);
    } catch (e) {
      // Safe fallback if DOM geometry is uninitialized in headless test environment
    }
  }

  exports.applyStep = applyStep;
})(typeof exports !== 'undefined' ? exports : (window.PlaybackModule = {}));
