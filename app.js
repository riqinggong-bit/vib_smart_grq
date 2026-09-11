const layouts={
  hand:['手账决策本','把推理、比较和结论写成一页手账'],
  terminal:['双区分析台','用终端视角查看约束、数据与判断'],
  magazine:['专题编辑部','用杂志叙事读懂完整答案'],
  ice:['ICE. 速览报','先看结论，再快速扫描关键证据'],
  minimal:['留白阅读页','去掉干扰，专注逻辑和行动清单'],
  app:['任务工作台','把答案变成可勾选、可调整的操作台'],
  neon:['数据驾驶舱','用指标与图表掌握决策重点']
};

const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({
  '&':'&amp;',
  '<':'&lt;',
  '>':'&gt;',
  '"':'&quot;',
  "'":'&#39;'
}[c]));

const clip=(v,n)=>{
  const s=String(v||'').replace(/\s+/g,' ').trim();
  return s.length>n?s.slice(0,n-1)+'…':s;
};

const imageFiles=[];
let plan,page,query='',active=-1,busy=false,checks=new Set();

const pages=new Map();
const checksets=new Map();
const controls=new Map();

const storeKey='liquid-web-v7';

function go(id){
  ['start','selection','result'].forEach(x=>{
    $('#'+x).classList.toggle(
      'hidden',
      x!==id
    );
  });

  scrollTo(0,0);
}

function save(){
  if(!plan)return;

  localStorage.setItem(
    storeKey,
    JSON.stringify({
      plan,
      query,
      pages:Object.fromEntries(pages),
      checks:Object.fromEntries(
        [...checksets].map(
          ([k,v])=>[k,[...v]]
        )
      ),
      controls:Object.fromEntries(
        controls
      ),
      active,
      showResult:
        !$('#result')
          .classList
          .contains('hidden')
    })
  );
}

/* =========================================================
   七种方案预览
========================================================= */

function preview(layout,title){
  const [name]=layouts[layout];

  if(layout==='terminal'){
    return `
      <div class="pv terminal-pv">
        <code>TASK_ANALYSIS_V2.0</code>
        <i></i>
        <i></i>
        <b>▂▅▃▇▆</b>
      </div>
    `;
  }

  if(layout==='magazine'){
    return `
      <div class="pv magazine-pv">
        <em>
          双<br>
          面<br>
          决<br>
          策
        </em>

        <small>
          ISSUE 01
        </small>
      </div>
    `;
  }

  if(layout==='ice'){
    return `
      <div class="pv ice-pv">
        <b>
          ICE.
        </b>

        <small>
          NO. 01 / BRIEF
        </small>
      </div>
    `;
  }

  if(layout==='minimal'){
    return `
      <div class="pv minimal-pv">
        <small>
          Answer · Focus
        </small>

        <i></i>
        <i></i>
      </div>
    `;
  }

  if(layout==='app'){
    return `
      <div class="pv app-pv">
        <span>
          ▣ 任务总览
        </span>

        <div>
          ✓ 核心结论
          <i>查看</i>
        </div>
      </div>
    `;
  }

  if(layout==='neon'){
    return `
      <div class="pv neon-pv">
        <b>✣</b>

        <span>
          FACTS　◆◆◆
          <br>
          STATUS　READY
        </span>
      </div>
    `;
  }

  return `
    <div class="pv hand-pv">
      <b>
        📝 ${esc(clip(title||name,11))} ♥
      </b>

      <small>
        #just for you
      </small>

      <i></i>
    </div>
  `;
}

function renderPlans(){
  if(!plan)return;

  $('#form-grid').innerHTML=
    plan.variants
      .map((v,i)=>{
        const meta=layouts[v.layout];

        return `
          <button
            class="form"
            data-variant="${i}"
            ${busy?'disabled':''}
          >
            ${preview(v.layout,v.title)}

            <div class="form-meta">
              <b>
                ${esc(meta[0])}
              </b>

              <span>
                ${esc(v.layout)}
              </span>
            </div>

            <div class="tags">
              ${
                v.components
                  .slice(0,3)
                  .map(
                    x=>`<i>${esc(x)}</i>`
                  )
                  .join('')
              }
            </div>

            <p>
              ${
                esc(
                  clip(
                    v.focus||meta[1],
                    62
                  )
                )
              }
            </p>

            <footer>
              <span>
                ${
                  pages.has(i)
                    ? '● 已生成'
                    : '✦ 同一份答案'
                }
              </span>

              <strong>
                ${
                  busy&&active===i
                    ? '生成中…'
                    : '立即进入 →'
                }
              </strong>
            </footer>
          </button>
        `;
      })
      .join('');
}

/* =========================================================
   Facts / Evidence
========================================================= */

function factStatus(f){
  if(f.kind==='user'){
    return '用户提供';
  }

  if(f.kind==='assumption'){
    return '假设';
  }

  if(f.kind==='calculation'){
    return '计算';
  }

  return f.status==='verified'
    ? '已核实'
    : '待核实';
}

function evidenceList(f){
  const ev=
    Array.isArray(f.evidence)
      ? f.evidence
      : [];

  if(!ev.length){
    return `
      <div class="evidence-empty">
        这条信息暂未取得可反查网页证据，
        不能当作已核实外部事实。
      </div>
    `;
  }

  return `
    <div class="evidence-list">
      ${
        ev.map(x=>`
          <article>
            <div>
              <b>
                ${esc(x.title||'网页来源')}
              </b>

              <i>
                ${esc(x.sourceType||'web')}
              </i>
            </div>

            ${
              x.snippet
                ? `
                  <blockquote>
                    ${esc(x.snippet)}
                  </blockquote>
                `
                : ''
            }

            <small>
              检索时间：
              ${
                esc(
                  (x.retrievedAt||'')
                    .replace('T',' ')
                    .slice(0,19)
                )
              }
            </small>

            <a
              href="${esc(x.url)}"
              target="_blank"
              rel="noopener noreferrer"
            >
              查看原始网页 →
            </a>
          </article>
        `).join('')
      }
    </div>
  `;
}

function factNote(ids=[]){
  const fs=
    (plan.sharedFacts||[])
      .filter(
        f=>ids.includes(f.id)
      );

  if(!fs.length){
    return '';
  }

  return `
    <details class="fact-note">
      <summary>
        🔎 查看依据 · ${fs.length} 条事实
      </summary>

      ${
        fs.map(f=>`
          <details class="claim">
            <summary>
              <b class="status-${esc(f.status)}">
                ${esc(factStatus(f))}
              </b>

              <span>
                ${esc(f.statement)}
              </span>
            </summary>

            ${evidenceList(f)}
          </details>
        `).join('')
      }
    </details>
  `;
}

/* =========================================================
   通用组件
========================================================= */

function table(rows,pick=false){
  if(!rows?.length){
    return '';
  }

  const headers=
    rows[0]
      .map(x=>String(x||''));

  return `
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            ${
              rows[0]
                .map(
                  x=>`<th>${esc(x)}</th>`
                )
                .join('')
            }
          </tr>
        </thead>

        <tbody>
          ${
            rows.slice(1)
              .map((r,i)=>`
                <tr
                  ${
                    pick
                      ? `tabindex="0" data-choice="${i}"`
                      : ''
                  }
                >
                  ${
                    r.map((x,j)=>`
                      <td data-label="${esc(headers[j]||'字段')}">
                        ${
                          j===0
                            ? '<b>'+esc(x)+'</b>'
                            : esc(x)
                        }
                      </td>
                    `).join('')
                  }
                </tr>
              `)
              .join('')
          }
        </tbody>
      </table>
    </div>

    ${
      pick
        ? `
          <p class="choice-result">
            点击一行，标记你的选择
          </p>
        `
        : ''
    }
  `;
}

function calculator(s,n){
  return `
    <div
      class="calculator"
      data-formula="${s.formula}"
      data-label="${esc(s.resultLabel)}"
    >
      ${
        s.fields.map((f,i)=>`
          <label>
            <span>
              ${esc(f.label)}
            </span>

            <output>
              ${f.value} ${esc(f.unit)}
            </output>

            <input
              type="range"
              min="${f.min}"
              max="${f.max}"
              step="${f.step}"
              value="${f.value}"
              data-field="${n}-${i}"
              data-unit="${esc(f.unit)}"
            >
          </label>
        `).join('')
      }

      <strong class="calc-result"></strong>
    </div>
  `;
}

function chart(rows){
  if(
    !rows||
    rows.length<2
  ){
    return '';
  }

  const vals=
    rows.slice(1)
      .map(
        r=>Number(r[1])||0
      );

  const max=
    Math.max(
      1,
      ...vals
    );

  return `
    <div class="bar-chart">
      ${
        rows.slice(1)
          .map((r,i)=>`
            <div>
              <span>
                ${esc(r[0])}
              </span>

              <i
                style="
                  --size:${
                    Math.max(
                      4,
                      vals[i]/max*100
                    )
                  }%
                "
              ></i>

              <b>
                ${esc(r[1])}
              </b>
            </div>
          `)
          .join('')
      }
    </div>
  `;
}

function linkUrl(x){
  const q=
    encodeURIComponent(
      x.query
    );

  if(x.channel==='jd'){
    return `https://search.jd.com/Search?keyword=${q}`;
  }

  if(x.channel==='taobao'){
    return `https://s.taobao.com/search?q=${q}`;
  }

  return `https://www.baidu.com/s?wd=${
    encodeURIComponent(
      x.query+' 官方网站'
    )
  }`;
}

function actionLinks(links=[]){
  if(!links.length){
    return '';
  }

  return `
    <div class="product-links">
      <h3>
        🛍️ 品牌与选购入口

        <small>
          价格和库存以平台实时页面为准
        </small>
      </h3>

      <div>
        ${
          links.map(x=>`
            <article>
              <span class="brand-mark">
                ${
                  esc(
                    x.label
                      .slice(0,2)
                      .toUpperCase()
                  )
                }
              </span>

              <p>
                <b>
                  ${esc(x.label)}
                </b>

                <small>
                  ${esc(x.query)}
                </small>
              </p>

              <a
                href="${linkUrl(x)}"
                target="_blank"
                rel="noopener noreferrer"
              >
                ${
                  x.channel==='jd'
                    ? '去京东看看'
                    : x.channel==='taobao'
                      ? '去淘宝看看'
                      : '查找品牌官网'
                } →
              </a>
            </article>
          `).join('')
        }
      </div>
    </div>
  `;
}

function section(s,n){
  let c='';

  if(
    ['steps','timeline']
      .includes(s.type)
  ){
    c=`
      <ol class="steps ${s.type}">
        ${
          s.items
            .map((x,i)=>`
              <li>
                <span>
                  ${
                    String(i+1)
                      .padStart(2,'0')
                  }
                </span>

                ${esc(x)}
              </li>
            `)
            .join('')
        }
      </ol>
    `;
  }

  else if(
    s.type==='cards'
  ){
    c=`
      <div class="cards">
        ${
          s.items
            .map((x,i)=>`
              <article>
                <span>
                  ${
                    [
                      '💡',
                      '🎯',
                      '✨',
                      '📌'
                    ][i%4]
                  }
                </span>

                ${esc(x)}
              </article>
            `)
            .join('')
        }
      </div>
    `;
  }

  else if(
    s.type==='table'
  ){
    c=table(s.rows);
  }

  else if(
    s.type==='comparison'
  ){
    c=table(
      s.rows,
      true
    );
  }

  else if(
    s.type==='barChart'
  ){
    c=chart(s.rows);
  }

  else if(
    s.type==='calculator'
  ){
    c=calculator(s,n);
  }

  else if(
    s.type==='checklist'
  ){
    c=`
      <div class="checklist">
        ${
          s.items
            .map((x,j)=>`
              <label>
                <input
                  type="checkbox"
                  data-check="${n}-${j}"
                  ${
                    checks.has(n+'-'+j)
                      ? 'checked'
                      : ''
                  }
                >

                <span>
                  ${esc(x)}
                </span>
              </label>
            `)
            .join('')
        }
      </div>
    `;
  }

  else{
    c=`
      <ul class="narrative-list">
        ${
          s.items
            .map(
              x=>`<li>${esc(x)}</li>`
            )
            .join('')
        }
      </ul>
    `;
  }

  return `
    <section
      class="module type-${s.type}"
      id="module-${n}"
    >
      <div class="module-heading">
        <span>
          ${
            String(n+1)
              .padStart(2,'0')
          }
        </span>

        <h2>
          ${esc(s.heading)}
        </h2>
      </div>

      <p class="module-intro">
        ${esc(s.intro)}
      </p>

      ${c}

      ${actionLinks(s.links)}

      ${factNote(s.factIds)}
    </section>
  `;
}

function renderToolbar(label){
  return `
    <header class="result-toolbar">
      <button
        id="back"
        class="back"
      >
        ← 七种形态
      </button>

      <span>
        ${esc(label)}
      </span>

      <button
        id="fresh"
        class="back"
      >
        新建 Query ＋
      </button>
    </header>
  `;
}

function closingTips(page){
  const last=
    page.sections
      .slice(-1)[0];

  const tips=
    (last?.items||[])
      .slice(0,3);

  return tips.length
    ? tips
    : [page.summary];
}

function renderClosing(
  page,
  className='closing'
){
  return `
    <section class="${className}">
      <h2>
        🤔 还在纠结？看这里
      </h2>

      <div>
        ${
          closingTips(page)
            .map((x,i)=>`
              <article>
                <span>
                  ${
                    [
                      '🌡️',
                      '🎒',
                      '💡'
                    ][i%3]
                  }
                </span>

                ${esc(clip(x,70))}
              </article>
            `)
            .join('')
        }
      </div>

      <p>
        这份内容由 AI 根据你的 Query
        实时生成。重要事实与价格请在行动前再次核实。
      </p>
    </section>
  `;
}

/* =========================================================
   01 HAND
========================================================= */

function renderHand(
  page,
  plan
){
  const chips=
    plan.constraints
      .slice(0,6)
      .map(
        x=>`<i>${esc(x)}</i>`
      )
      .join('');

  const nav=
    page.sections
      .map((s,i)=>`
        <a href="#module-${i}">
          ${
            String(i+1)
              .padStart(2,'0')
          }

          ${esc(s.heading)}
        </a>
      `)
      .join('');

  return `
    ${renderToolbar('手账决策本')}

    <main class="hand-page">

      <div class="hand-tape"></div>

      <header class="hand-cover">
        <p>
          ✦ MY DECISION NOTE · JUST FOR YOU
        </p>

        <h1>
          ${esc(page.title)}
        </h1>

        <h3>
          ${esc(page.subtitle)}
        </h3>
      </header>

      <section class="hand-question">
        <span>
          📝
        </span>

        <div>
          <small>
            我想解决的问题
          </small>

          <p>
            ${esc(query)}
          </p>
        </div>
      </section>

      <div class="hand-chips">
        ${chips}
      </div>

      <section class="hand-summary">
        <span>
          💡
        </span>

        <div>
          <small>
            先说结论
          </small>

          <strong>
            ${esc(page.summary)}
          </strong>
        </div>
      </section>

      <nav class="hand-nav">
        ${nav}
      </nav>

      <div class="hand-modules">
        ${
          page.sections
            .map(section)
            .join('')
        }
      </div>

      ${
        renderClosing(
          page,
          'hand-closing'
        )
      }

    </main>
  `;
}

/* =========================================================
   02 TERMINAL
========================================================= */

function terminalItems(s,n){
  if(
    ['table','comparison']
      .includes(s.type)
  ){
    return table(
      s.rows,
      s.type==='comparison'
    );
  }

  if(
    s.type==='barChart'
  ){
    return chart(s.rows);
  }

  if(
    s.type==='calculator'
  ){
    return calculator(s,n);
  }

  if(
    s.type==='checklist'
  ){
    return `
      <div class="terminal-checklist">
        ${
          s.items
            .map((x,j)=>`
              <label>
                <input
                  type="checkbox"
                  data-check="${n}-${j}"
                  ${
                    checks.has(n+'-'+j)
                      ? 'checked'
                      : ''
                  }
                >

                <code>
                  [
                  ${
                    checks.has(n+'-'+j)
                      ? 'x'
                      : ' '
                  }
                  ]
                </code>

                <span>
                  ${esc(x)}
                </span>
              </label>
            `)
            .join('')
        }
      </div>
    `;
  }

  if(
    s.type==='cards'
  ){
    return `
      <div class="terminal-cards">
        ${
          s.items
            .map((x,i)=>`
              <article>
                <small>
                  CARD_${
                    String(i+1)
                      .padStart(2,'0')
                  }
                </small>

                <p>
                  ${esc(x)}
                </p>
              </article>
            `)
            .join('')
        }
      </div>
    `;
  }

  return `
    <div class="terminal-lines">
      ${
        s.items
          .map((x,i)=>`
            <div>
              <span>
                ${
                  String(i+1)
                    .padStart(2,'0')
                }
              </span>

              <p>
                ${esc(x)}
              </p>

              <i>
                OK
              </i>
            </div>
          `)
          .join('')
      }
    </div>
  `;
}

function renderTerminalSection(s,n){
  return `
    <section
      class="terminal-block"
      id="module-${n}"
    >
      <header>
        <span>
          [
          ${
            String(n+1)
              .padStart(2,'0')
          }
          ]
        </span>

        <h2>
          ${esc(s.heading)}
        </h2>

        <i>
          READY
        </i>
      </header>

      <p class="terminal-intro">
        &gt; ${esc(s.intro)}
      </p>

      ${terminalItems(s,n)}

      ${actionLinks(s.links)}

      ${factNote(s.factIds)}
    </section>
  `;
}

function renderTerminal(
  page,
  plan
){
  const constraints=
    plan.constraints
      .map((x,i)=>`
        <div class="terminal-row">
          <span>
            INPUT_${
              String(i+1)
                .padStart(2,'0')
            }
          </span>

          <b>
            ${esc(x)}
          </b>

          <i>
            OK
          </i>
        </div>
      `)
      .join('');

  return `
    ${renderToolbar('双区分析台')}

    <main class="terminal-page">

      <header class="terminal-header">

        <div class="terminal-statusbar">
          <span>
            LIQUID_AI /
            DECISION_ENGINE_V2.0
          </span>

          <i>
            ● SYSTEM ONLINE
          </i>
        </div>

        <div class="terminal-title">
          <small>
            &gt; ANALYZE_TASK
          </small>

          <h1>
            ${esc(page.title)}
          </h1>

          <p>
            ${esc(page.subtitle)}
          </p>
        </div>

      </header>

      <div class="terminal-grid">

        <aside class="terminal-sidebar">

          <div class="terminal-panel-title">
            &gt; USER_REQUIREMENTS
          </div>

          ${constraints}

          <div class="terminal-side-stat">
            <small>
              CONSTRAINTS
            </small>

            <strong>
              ${
                String(
                  plan.constraints.length
                ).padStart(2,'0')
              }
            </strong>
          </div>

          <div class="terminal-side-stat">
            <small>
              MODULES
            </small>

            <strong>
              ${
                String(
                  page.sections.length
                ).padStart(2,'0')
              }
            </strong>
          </div>

          <div class="terminal-side-ready">
            <span>
              STATUS
            </span>

            <b>
              READY
            </b>
          </div>

        </aside>

        <div class="terminal-main">

          <section class="terminal-final">
            <small>
              &gt; FINAL_RESULT
            </small>

            <strong>
              ${esc(page.summary)}
            </strong>

            <div>
              CONFIDENCE
              <i></i>
              RESULT_READY
            </div>
          </section>

          <div class="terminal-sections">
            ${
              page.sections
                .map(renderTerminalSection)
                .join('')
            }
          </div>

        </div>

      </div>

      <footer class="terminal-footer">
        <span>
          END_OF_ANALYSIS
        </span>

        <i>
          _
        </i>
      </footer>

    </main>
  `;
}

/* =========================================================
   03 MAGAZINE
========================================================= */

function magazineContent(s,n){
  if(
    ['comparison','table']
      .includes(s.type)
  ){
    return table(
      s.rows,
      s.type==='comparison'
    );
  }

  if(
    s.type==='barChart'
  ){
    return chart(s.rows);
  }

  if(
    s.type==='calculator'
  ){
    return calculator(s,n);
  }

  if(
    s.type==='checklist'
  ){
    return `
      <div class="magazine-checklist">
        ${
          s.items
            .map((x,j)=>`
              <label>
                <input
                  type="checkbox"
                  data-check="${n}-${j}"
                  ${
                    checks.has(n+'-'+j)
                      ? 'checked'
                      : ''
                  }
                >

                <span>
                  ${esc(x)}
                </span>
              </label>
            `)
            .join('')
        }
      </div>
    `;
  }

  if(
    s.type==='cards'
  ){
    return `
      <div class="magazine-cards">
        ${
          s.items
            .map((x,i)=>`
              <article>
                <small>
                  0${i+1}
                </small>

                <p>
                  ${esc(x)}
                </p>
              </article>
            `)
            .join('')
        }
      </div>
    `;
  }

  if(
    ['steps','timeline']
      .includes(s.type)
  ){
    return `
      <ol class="magazine-steps">
        ${
          s.items
            .map((x,i)=>`
              <li>
                <span>
                  ${
                    String(i+1)
                      .padStart(2,'0')
                  }
                </span>

                <p>
                  ${esc(x)}
                </p>
              </li>
            `)
            .join('')
        }
      </ol>
    `;
  }

  return `
    <div class="magazine-copy">
      ${
        s.items
          .map(
            x=>`<p>${esc(x)}</p>`
          )
          .join('')
      }
    </div>
  `;
}

function renderMagazineStory(s,n){
  return `
    <article
      class="magazine-story"
      id="module-${n}"
    >
      <span class="magazine-index">
        ${
          String(n+1)
            .padStart(2,'0')
        }
      </span>

      <small class="magazine-label">
        FEATURE /
        ${esc(s.type.toUpperCase())}
      </small>

      <h2>
        ${esc(s.heading)}
      </h2>

      <p class="magazine-intro">
        ${esc(s.intro)}
      </p>

      ${magazineContent(s,n)}

      ${actionLinks(s.links)}

      ${factNote(s.factIds)}
    </article>
  `;
}

function renderMagazine(
  page,
  plan
){
  const first=
    page.sections[0];

  const rest=
    page.sections.slice(1);

  const constraints=
    plan.constraints
      .slice(0,6)
      .map(
        x=>`<span>${esc(x)}</span>`
      )
      .join('');

  return `
    ${renderToolbar('专题编辑部')}

    <main class="magazine-page">

      <header class="magazine-cover">

        <div class="magazine-kicker">
          <b>
            LIQUID INTELLIGENCE
          </b>

          <span>
            ISSUE 01 ·
            ${new Date().getFullYear()}
          </span>
        </div>

        <div class="magazine-title-grid">

          <div>
            <small>
              THE DECISION ISSUE
            </small>

            <h1>
              ${esc(page.title)}
            </h1>
          </div>

          <p>
            ${esc(page.subtitle)}
          </p>

        </div>

        <div class="magazine-query">
          <small>
            ORIGINAL QUERY
          </small>

          <p>
            ${esc(query)}
          </p>
        </div>

      </header>

      <section class="magazine-constraints">
        ${constraints}
      </section>

      <section class="magazine-lead">

        <div>
          <small>
            EDITOR'S PICK
          </small>

          <span>
            结论
          </span>
        </div>

        <blockquote>
          ${esc(page.summary)}
        </blockquote>

      </section>

      ${
        first
          ? `
            <section
              class="magazine-feature"
              id="module-0"
            >
              <div class="magazine-big-number">
                01
              </div>

              <article>
                <small>
                  COVER STORY
                </small>

                <h2>
                  ${esc(first.heading)}
                </h2>

                <p class="magazine-feature-intro">
                  ${esc(first.intro)}
                </p>

                ${magazineContent(first,0)}

                ${actionLinks(first.links)}

                ${factNote(first.factIds)}
              </article>
            </section>
          `
          : ''
      }

      <div class="magazine-divider">
        <span>
          INSIDE THIS ISSUE
        </span>
      </div>

      <div class="magazine-columns">
        ${
          rest
            .map(
              (s,i)=>
                renderMagazineStory(
                  s,
                  i+1
                )
            )
            .join('')
        }
      </div>

      ${
        renderClosing(
          page,
          'magazine-closing'
        )
      }

    </main>
  `;
}

/* =========================================================
   04 ICE
========================================================= */

function iceSection(s,n){
  const compact=
    s.items.slice(0,4);

  let body='';

  if(
    ['table','comparison']
      .includes(s.type)
  ){
    body=table(
      s.rows,
      s.type==='comparison'
    );
  }

  else if(
    s.type==='barChart'
  ){
    body=chart(s.rows);
  }

  else if(
    s.type==='calculator'
  ){
    body=calculator(s,n);
  }

  else if(
    s.type==='checklist'
  ){
    body=`
      <div class="ice-checklist">
        ${
          compact
            .map((x,j)=>`
              <label>
                <input
                  type="checkbox"
                  data-check="${n}-${j}"
                  ${
                    checks.has(n+'-'+j)
                      ? 'checked'
                      : ''
                  }
                >

                <span>
                  ${esc(x)}
                </span>
              </label>
            `)
            .join('')
        }
      </div>
    `;
  }

  else{
    body=`
      <div class="ice-points">
        ${
          compact
            .map((x,i)=>`
              <div>
                <b>
                  ${
                    String(i+1)
                      .padStart(2,'0')
                  }
                </b>

                <span>
                  ${esc(x)}
                </span>
              </div>
            `)
            .join('')
        }
      </div>
    `;
  }

  return `
    <section
      class="ice-section"
      id="module-${n}"
    >
      <div class="ice-section-head">
        <span>
          ${
            String(n+1)
              .padStart(2,'0')
          }
        </span>

        <h2>
          ${esc(s.heading)}
        </h2>
      </div>

      <p>
        ${esc(s.intro)}
      </p>

      ${body}

      ${actionLinks(s.links)}

      ${factNote(s.factIds)}
    </section>
  `;
}

function renderIce(
  page,
  plan
){
  const facts=
    (plan.sharedFacts||[])
      .slice(0,3);

  const metrics=[
    [
      '约束',
      String(
        plan.constraints.length
      ).padStart(2,'0')
    ],
    [
      '模块',
      String(
        page.sections.length
      ).padStart(2,'0')
    ],
    [
      '事实',
      String(
        (plan.sharedFacts||[]).length
      ).padStart(2,'0')
    ]
  ];

  return `
    ${renderToolbar('ICE. 速览报')}

    <main class="ice-page">

      <header class="ice-topline">
        <b>
          ICE.
        </b>

        <span>
          INTELLIGENT CONTENT
          EXECUTIVE BRIEF
        </span>

        <i>
          NO. 01
        </i>
      </header>

      <section class="ice-hero">

        <div>
          <small>
            THE ANSWER / 结论先行
          </small>

          <h1>
            ${esc(page.title)}
          </h1>

          <p>
            ${esc(page.subtitle)}
          </p>
        </div>

        <aside>
          ${
            metrics
              .map(([k,v])=>`
                <div>
                  <strong>
                    ${v}
                  </strong>

                  <span>
                    ${k}
                  </span>
                </div>
              `)
              .join('')
          }
        </aside>

      </section>

      <section class="ice-verdict">
        <span>
          RECOMMENDATION
        </span>

        <strong>
          ${esc(page.summary)}
        </strong>
      </section>

      <section class="ice-constraints">
        <small>
          HARD CONSTRAINTS
        </small>

        <div>
          ${
            plan.constraints
              .slice(0,8)
              .map(
                x=>`<span>${esc(x)}</span>`
              )
              .join('')
          }
        </div>
      </section>

      ${
        facts.length
          ? `
            <section class="ice-facts">
              <small>
                FACT CHECK
              </small>

              <div>
                ${
                  facts
                    .map(f=>`
                      <article>
                        <b>
                          ${esc(factStatus(f))}
                        </b>

                        <p>
                          ${esc(f.statement)}
                        </p>
                      </article>
                    `)
                    .join('')
                }
              </div>
            </section>
          `
          : ''
      }

      <div class="ice-sections">
        ${
          page.sections
            .map(iceSection)
            .join('')
        }
      </div>

      <footer class="ice-footer">
        BRIEF END ·
        重要事实与价格请在行动前再次核实
      </footer>

    </main>
  `;
}

/* =========================================================
   05 MINIMAL
========================================================= */

function minimalContent(s,n){
  if(
    ['table','comparison']
      .includes(s.type)
  ){
    return table(
      s.rows,
      s.type==='comparison'
    );
  }

  if(
    s.type==='barChart'
  ){
    return chart(s.rows);
  }

  if(
    s.type==='calculator'
  ){
    return calculator(s,n);
  }

  if(
    s.type==='checklist'
  ){
    return `
      <div class="minimal-checklist">
        ${
          s.items
            .map((x,j)=>`
              <label>
                <input
                  type="checkbox"
                  data-check="${n}-${j}"
                  ${
                    checks.has(n+'-'+j)
                      ? 'checked'
                      : ''
                  }
                >

                <span>
                  ${esc(x)}
                </span>
              </label>
            `)
            .join('')
        }
      </div>
    `;
  }

  return `
    <div class="minimal-copy">
      ${
        s.items
          .map(
            x=>`<p>${esc(x)}</p>`
          )
          .join('')
      }
    </div>
  `;
}

function renderMinimal(
  page,
  plan
){
  return `
    ${renderToolbar('留白阅读页')}

    <main class="minimal-page">

      <header class="minimal-cover">
        <small>
          LIQUID / FOCUS
        </small>

        <h1>
          ${esc(page.title)}
        </h1>

        <p>
          ${esc(page.subtitle)}
        </p>
      </header>

      <section class="minimal-query">
        <span>
          问题
        </span>

        <p>
          ${esc(query)}
        </p>
      </section>

      <blockquote class="minimal-summary">
        ${esc(page.summary)}
      </blockquote>

      <nav class="minimal-nav">
        ${
          page.sections
            .map((s,i)=>`
              <a href="#module-${i}">
                <span>
                  ${
                    String(i+1)
                      .padStart(2,'0')
                  }
                </span>

                ${esc(s.heading)}
              </a>
            `)
            .join('')
        }
      </nav>

      <article class="minimal-essay">

        ${
          page.sections
            .map((s,n)=>`
              <section
                class="minimal-section"
                id="module-${n}"
              >
                <small>
                  ${
                    String(n+1)
                      .padStart(2,'0')
                  }
                  /
                  ${esc(s.type.toUpperCase())}
                </small>

                <h2>
                  ${esc(s.heading)}
                </h2>

                <p class="minimal-intro">
                  ${esc(s.intro)}
                </p>

                ${minimalContent(s,n)}

                ${actionLinks(s.links)}

                ${factNote(s.factIds)}
              </section>
            `)
            .join('')
        }

      </article>

      <footer class="minimal-footer">
        <span>
          NOTES
        </span>

        <p>
          ${esc(plan.constraints.join(' · '))}
        </p>

        <small>
          重要事实与价格请在行动前再次核实。
        </small>
      </footer>

    </main>
  `;
}

/* =========================================================
   06 APP
========================================================= */

function appSectionBody(s,n){
  if(
    ['table','comparison']
      .includes(s.type)
  ){
    return table(
      s.rows,
      s.type==='comparison'
    );
  }

  if(
    s.type==='barChart'
  ){
    return chart(s.rows);
  }

  if(
    s.type==='calculator'
  ){
    return calculator(s,n);
  }

  if(
    s.type==='checklist'
  ){
    return `
      <div class="app-checklist">
        ${
          s.items
            .map((x,j)=>`
              <label>
                <input
                  type="checkbox"
                  data-check="${n}-${j}"
                  ${
                    checks.has(n+'-'+j)
                      ? 'checked'
                      : ''
                  }
                >

                <span>
                  ${esc(x)}
                </span>

                <i>
                  ${
                    checks.has(n+'-'+j)
                      ? 'DONE'
                      : 'TODO'
                  }
                </i>
              </label>
            `)
            .join('')
        }
      </div>
    `;
  }

  if(
    s.type==='cards'
  ){
    return `
      <div class="app-cards">
        ${
          s.items
            .map((x,i)=>`
              <article>
                <span>
                  ${
                    [
                      '✓',
                      '→',
                      '★',
                      '!'
                    ][i%4]
                  }
                </span>

                <p>
                  ${esc(x)}
                </p>
              </article>
            `)
            .join('')
        }
      </div>
    `;
  }

  return `
    <ul class="app-list">
      ${
        s.items
          .map(x=>`
            <li>
              <span>
                •
              </span>

              ${esc(x)}
            </li>
          `)
          .join('')
      }
    </ul>
  `;
}

function renderApp(
  page,
  plan
){
  const total=
    page.sections.length;

  const done=
    Math.max(
      1,
      Math.round(total*.55)
    );

  const progress=
    Math.round(
      done/total*100
    );

  return `
    ${renderToolbar('任务工作台')}

    <main class="app-shell">

      <aside class="app-sidebar">

        <div class="app-logo">
          <span>
            LIQUID
          </span>

          <b>
            Workspace
          </b>
        </div>

        <div class="app-progress">
          <small>
            任务进度
          </small>

          <strong>
            ${progress}%
          </strong>

          <i>
            <b
              style="width:${progress}%"
            ></b>
          </i>
        </div>

        <nav>
          ${
            page.sections
              .map((s,i)=>`
                <a href="#module-${i}">
                  <span>
                    ${
                      String(i+1)
                        .padStart(2,'0')
                    }
                  </span>

                  ${esc(s.heading)}
                </a>
              `)
              .join('')
          }
        </nav>

        <div class="app-sidebar-note">
          <small>
            原始需求
          </small>

          <p>
            ${esc(clip(query,160))}
          </p>
        </div>

      </aside>

      <section class="app-main">

        <header class="app-header">

          <div>
            <small>
              DECISION WORKSPACE
            </small>

            <h1>
              ${esc(page.title)}
            </h1>

            <p>
              ${esc(page.subtitle)}
            </p>
          </div>

          <button type="button">
            ● READY
          </button>

        </header>

        <section class="app-overview">

          <div class="app-recommend">
            <small>
              核心结论
            </small>

            <strong>
              ${esc(page.summary)}
            </strong>
          </div>

          <div class="app-kpis">

            <article>
              <b>
                ${plan.constraints.length}
              </b>

              <span>
                约束
              </span>
            </article>

            <article>
              <b>
                ${page.sections.length}
              </b>

              <span>
                任务块
              </span>
            </article>

            <article>
              <b>
                ${(plan.sharedFacts||[]).length}
              </b>

              <span>
                事实
              </span>
            </article>

          </div>

        </section>

        <section class="app-constraints">
          <h3>
            当前条件
          </h3>

          <div>
            ${
              plan.constraints
                .slice(0,8)
                .map(
                  x=>`<span>${esc(x)}</span>`
                )
                .join('')
            }
          </div>
        </section>

        <div class="app-workspace">

          ${
            page.sections
              .map((s,n)=>`
                <section
                  class="app-panel"
                  id="module-${n}"
                >
                  <header>
                    <div>
                      <small>
                        STEP ${
                          String(n+1)
                            .padStart(2,'0')
                        }
                      </small>

                      <h2>
                        ${esc(s.heading)}
                      </h2>
                    </div>

                    <span>
                      ${esc(s.type)}
                    </span>
                  </header>

                  <p class="app-panel-intro">
                    ${esc(s.intro)}
                  </p>

                  ${appSectionBody(s,n)}

                  ${actionLinks(s.links)}

                  ${factNote(s.factIds)}
                </section>
              `)
              .join('')
          }

        </div>

      </section>

    </main>
  `;
}

/* =========================================================
   07 NEON
========================================================= */

function neonSection(s,n){
  let body='';

  if(
    ['table','comparison']
      .includes(s.type)
  ){
    body=table(
      s.rows,
      s.type==='comparison'
    );
  }

  else if(
    s.type==='barChart'
  ){
    body=chart(s.rows);
  }

  else if(
    s.type==='calculator'
  ){
    body=calculator(s,n);
  }

  else if(
    s.type==='checklist'
  ){
    body=`
      <div class="neon-checklist">
        ${
          s.items
            .map((x,j)=>`
              <label>
                <input
                  type="checkbox"
                  data-check="${n}-${j}"
                  ${
                    checks.has(n+'-'+j)
                      ? 'checked'
                      : ''
                  }
                >

                <span>
                  ${esc(x)}
                </span>
              </label>
            `)
            .join('')
        }
      </div>
    `;
  }

  else{
    body=`
      <div class="neon-points">
        ${
          s.items
            .slice(0,6)
            .map((x,i)=>`
              <article>
                <b>
                  ${
                    String(i+1)
                      .padStart(2,'0')
                  }
                </b>

                <p>
                  ${esc(x)}
                </p>
              </article>
            `)
            .join('')
        }
      </div>
    `;
  }

  return `
    <section
      class="neon-panel"
      id="module-${n}"
    >
      <header>
        <span>
          MODULE_${
            String(n+1)
              .padStart(2,'0')
          }
        </span>

        <h2>
          ${esc(s.heading)}
        </h2>

        <i>
          LIVE
        </i>
      </header>

      <p>
        ${esc(s.intro)}
      </p>

      ${body}

      ${actionLinks(s.links)}

      ${factNote(s.factIds)}
    </section>
  `;
}

function renderNeon(
  page,
  plan
){
  const status=
    (plan.sharedFacts||[])
      .reduce((a,f)=>{
        a[f.status]=
          (a[f.status]||0)+1;

        return a;
      },{});

  const score=
    Math.min(
      99,
      70+
      Math.min(
        20,
        plan.constraints.length*3
      )+
      Math.min(
        9,
        page.sections.length
      )
    );

  return `
    ${renderToolbar('数据驾驶舱')}

    <main class="neon-page">

      <header class="neon-header">

        <div>
          <span>
            LIQUID // COMMAND CENTER
          </span>

          <i>
            ● LIVE
          </i>
        </div>

        <h1>
          ${esc(page.title)}
        </h1>

        <p>
          ${esc(page.subtitle)}
        </p>

      </header>

      <section class="neon-kpis">

        <article class="neon-score">
          <small>
            DECISION SCORE
          </small>

          <strong>
            ${score}
          </strong>

          <span>
            / 100
          </span>
        </article>

        <article>
          <small>
            CONSTRAINTS
          </small>

          <strong>
            ${
              String(
                plan.constraints.length
              ).padStart(2,'0')
            }
          </strong>

          <span>
            LOCKED
          </span>
        </article>

        <article>
          <small>
            VERIFIED
          </small>

          <strong>
            ${
              String(
                status.verified||0
              ).padStart(2,'0')
            }
          </strong>

          <span>
            FACTS
          </span>
        </article>

        <article>
          <small>
            UNVERIFIED
          </small>

          <strong>
            ${
              String(
                status.unverified||0
              ).padStart(2,'0')
            }
          </strong>

          <span>
            CHECK
          </span>
        </article>

      </section>

      <section class="neon-command">

        <div>
          <small>
            PRIMARY OUTPUT
          </small>

          <strong>
            ${esc(page.summary)}
          </strong>
        </div>

        <aside>
          ${
            plan.constraints
              .slice(0,5)
              .map((x,i)=>`
                <span>
                  <b>
                    0${i+1}
                  </b>

                  ${esc(x)}
                </span>
              `)
              .join('')
          }
        </aside>

      </section>

      <div class="neon-grid">
        ${
          page.sections
            .map(neonSection)
            .join('')
        }
      </div>

      <footer class="neon-footer">
        <span>
          DATA STREAM COMPLETE
        </span>

        <i>
          重要事实与价格请在行动前再次核实
        </i>
      </footer>

    </main>
  `;
}

/* =========================================================
   Calculator / Events
========================================================= */

function updateCalc(){
  document
    .querySelectorAll(
      '.calculator'
    )
    .forEach(box=>{
      const v=
        [
          ...box.querySelectorAll(
            'input'
          )
        ]
        .map(
          x=>Number(x.value)
        );

      const total=
        box.dataset.formula==='product'
          ? v.reduce(
              (a,b)=>a*b,
              1
            )
          : v.reduce(
              (a,b)=>a+b,
              0
            );

      box.querySelector(
        '.calc-result'
      ).textContent=
        `${
          box.dataset.label||
          '计算结果'
        }：${
          Number(
            total.toFixed(2)
          )
        }`;
    });
}

function bindResultEvents(){
  const state=
    controls.get(active)||{};

  document
    .querySelectorAll(
      '.calculator input'
    )
    .forEach(input=>{
      if(
        state[
          input.dataset.field
        ]!=null
      ){
        input.value=
          state[
            input.dataset.field
          ];
      }

      const out=
        input.previousElementSibling;

      if(out){
        out.value=
          `${input.value} ${
            input.dataset.unit
          }`;
      }
    });

  $('#back').onclick=()=>{
    go('selection');
    save();
  };

  $('#fresh').onclick=
    reset;

  $('#result').oninput=e=>{
    if(
      !e.target.matches(
        '.calculator input'
      )
    ){
      return;
    }

    const out=
      e.target
        .previousElementSibling;

    if(out){
      out.value=
        `${e.target.value} ${
          e.target.dataset.unit
        }`;
    }

    controls.set(
      active,
      {
        ...(controls.get(active)||{}),
        [
          e.target.dataset.field
        ]:e.target.value
      }
    );

    updateCalc();

    save();
  };

  $('#result').onchange=e=>{
    const k=
      e.target.dataset.check;

    if(!k){
      return;
    }

    if(e.target.checked){
      checks.add(k);
    }else{
      checks.delete(k);
    }

    save();
  };

  $('#result').onclick=e=>{
    const row=
      e.target.closest(
        '[data-choice]'
      );

    if(!row){
      return;
    }

    const container=
      row.closest(
        '.module,'+
        '.terminal-block,'+
        '.magazine-story,'+
        '.magazine-feature,'+
        '.ice-section,'+
        '.minimal-section,'+
        '.app-panel,'+
        '.neon-panel'
      );

    const result=
      container
        ?.querySelector(
          '.choice-result'
        );

    if(result){
      result.textContent=
        '✓ 当前选择：'+
        [...row.children]
          .map(
            x=>x.textContent
          )
          .join(' · ');
    }
  };
}

/* =========================================================
   七种独立 Renderer Router
========================================================= */

function show(){
  const v=
    plan.variants[active];

  const renderers={
    hand:renderHand,
    terminal:renderTerminal,
    magazine:renderMagazine,
    ice:renderIce,
    minimal:renderMinimal,
    app:renderApp,
    neon:renderNeon
  };

  $('#result').className=
    `result layout-${v.layout}`;

  $('#result').innerHTML=
    renderers[v.layout](
      page,
      plan,
      v
    );

  bindResultEvents();

  go('result');

  updateCalc();

  save();
}

/* =========================================================
   请求 / Loading
========================================================= */

function loading(on,i){
  let box=
    $('#page-loading');

  if(on){
    if(!box){
      box=
        document.createElement(
          'div'
        );

      box.id=
        'page-loading';

      document.body.append(box);
    }

    box.innerHTML=`
      <div>
        <span>
          ✦
        </span>

        <h2>
          正在展开「${
            esc(
              layouts[
                plan.variants[i].layout
              ][0]
            )
          }」
        </h2>

        <p>
          AI 正在整理统一答案、
          品牌候选、比较依据与行动建议…
        </p>

        <i></i>

        <small>
          通常需要 15–60 秒，
          请不要关闭页面
        </small>
      </div>
    `;

    box.classList.add(
      'show'
    );
  }else{
    box?.classList.remove(
      'show'
    );
  }
}

async function openVariant(i){
  if(
    busy||
    !plan?.variants[i]
  ){
    return;
  }

  active=i;

  $('#plan-error').textContent='';

  if(!pages.has(i)){
    busy=true;

    loading(true,i);

    renderPlans();

    try{
      const r=
        await fetch(
          '/api/page',
          {
            method:'POST',

            headers:{
              'Content-Type':
                'application/json'
            },

            body:
              JSON.stringify({
                sessionId:
                  plan.sessionId,
                variantIndex:i
              }),

            signal:
              AbortSignal.timeout(
                110000
              )
          }
        );

      const d=
        await r.json();

      if(!r.ok){
        throw Error(
          d.error||
          '生成失败'
        );
      }

      /*
       * 七套页面共用同一份内容数据。
       * Renderer 只改变表现形式。
       */
      for(
        let n=0;
        n<7;
        n++
      ){
        pages.set(n,d);
      }

    }catch(e){
      $('#plan-error')
        .textContent=
          e.name==='TimeoutError'
            ? '生成时间较长，请再次点击重试。'
            : e.message;
    }finally{
      busy=false;

      loading(false);

      renderPlans();
    }
  }

  if(pages.has(i)){
    page=
      pages.get(i);

    checks=
      checksets.get(i)||
      new Set();

    checksets.set(
      i,
      checks
    );

    show();
  }
}

function reset(){
  localStorage.removeItem(
    storeKey
  );

  plan=null;
  page=null;
  query='';
  active=-1;

  pages.clear();
  checksets.clear();
  controls.clear();

  $('#query').value='';
  $('#image-notes').value='';
  imageFiles.length=0;
  renderImageList();

  go('start');
}

/* =========================================================
   Selection events
========================================================= */

$('#form-grid').onclick=e=>{
  const b=
    e.target.closest(
      '[data-variant]'
    );

  if(b){
    openVariant(
      Number(
        b.dataset.variant
      )
    );
  }
};

$('#new-query').onclick=
  reset;

function renderImageList(){
  const box=
    $('#image-list');

  if(!box){
    return;
  }

  box.innerHTML=
    imageFiles.length
      ? imageFiles
        .map(
          f=>`
            <span title="${esc(f.name)}">
              ${esc(clip(f.name,22))}
            </span>
          `
        )
        .join('')
      : '<small>未添加图片</small>';
}

$('#reference-images').onchange=e=>{
  imageFiles.length=0;

  imageFiles.push(
    ...[...e.target.files]
      .slice(0,6)
      .map(
        f=>({
          name:f.name,
          type:f.type,
          size:f.size
        })
      )
  );

  renderImageList();
};

function buildQuery(){
  const main=
    $('#query')
      .value
      .trim();

  const notes=
    $('#image-notes')
      .value
      .trim();

  if(
    !imageFiles.length&&
    !notes
  ){
    return main;
  }

  return [
    main,
    '',
    '【参考图片上下文】',
    imageFiles.length
      ? `用户上传/选择了 ${imageFiles.length} 张参考图片，文件名：${imageFiles.map(f=>f.name).join('、')}。当前版本无法直接识别图片像素，请主要依据用户填写的图片说明，不要声称已经看见图片细节。`
      : '用户没有选择图片文件，但提供了图片相关说明。',
    notes
      ? `图片说明：${notes}`
      : '图片说明：用户暂未填写，请不要臆测图片内容。'
  ].join('\n');
}

/* =========================================================
   Generate Query
========================================================= */

$('#query-form').onsubmit=
  async e=>{
    e.preventDefault();

    if(busy){
      return;
    }

    const q=
      buildQuery();

    if(!q){
      return;
    }

    busy=true;

    $('#generate').disabled=
      true;

    $('#error').textContent=
      '';

    $('#generate').textContent=
      '正在理解需求与组织统一答案…';

    try{
      const r=
        await fetch(
          '/api/plan',
          {
            method:'POST',

            headers:{
              'Content-Type':
                'application/json'
            },

            body:
              JSON.stringify({
                query:q
              }),

            signal:
              AbortSignal.timeout(
                110000
              )
          }
        );

      const d=
        await r.json();

      if(!r.ok){
        throw Error(
          d.error||
          '生成失败'
        );
      }

      plan=d;

      query=q;

      pages.clear();

      $('#selection-title')
        .textContent=
          plan.title;

      $('#selection-query')
        .textContent=
          q;

      busy=false;

      renderPlans();

      go('selection');

      save();

    }catch(e){
      $('#error')
        .textContent=
          e.name==='TimeoutError'
            ? '服务响应较慢，请再试一次。'
            : e.message;

    }finally{
      busy=false;

      $('#generate').disabled=
        false;

      $('#generate').textContent=
        '✦ 让 AI 生成专属网页';
    }
  };

/* =========================================================
   Restore
========================================================= */

async function restore(){
  let s;

  try{
    s=
      JSON.parse(
        localStorage.getItem(
          storeKey
        )
      );
  }catch{}

  if(
    !s?.plan?.sessionId
  ){
    return;
  }

  query=
    s.query||'';

  $('#query').value=
    query;

  try{
    const r=
      await fetch(
        '/api/session/'+
        encodeURIComponent(
          s.plan.sessionId
        )
      );

    const fresh=
      await r.json();

    if(!r.ok){
      throw Error();
    }

    plan={
      ...fresh
    };

    delete plan.pages;

    Object.entries({
      ...s.pages,
      ...fresh.pages
    }).forEach(
      ([k,v])=>
        pages.set(
          Number(k),
          v
        )
    );

    Object.entries(
      s.checks||{}
    ).forEach(
      ([k,v])=>
        checksets.set(
          Number(k),
          new Set(v)
        )
    );

    Object.entries(
      s.controls||{}
    ).forEach(
      ([k,v])=>
        controls.set(
          Number(k),
          v
        )
    );

    $('#selection-title')
      .textContent=
        plan.title;

    $('#selection-query')
      .textContent=
        query;

    renderPlans();

    if(
      s.showResult&&
      pages.has(s.active)
    ){
      active=
        s.active;

      page=
        pages.get(active);

      checks=
        checksets.get(active)||
        new Set();

      show();
    }else{
      go('selection');
    }

  }catch{
    $('#error')
      .textContent=
        '上次方案已过期，原 Query 已为你保留，请重新生成。';

    localStorage.removeItem(
      storeKey
    );

    go('start');
  }
}

/* =========================================================
   Health
========================================================= */

fetch('/api/health')
  .then(
    r=>r.json()
  )
  .then(s=>{
    $('#connection').textContent=
      s.ready
        ? '● 模型已连接 · 内容统一 · 七种形态'
        : '请先配置模型密钥';
  })
  .catch(()=>{
    $('#connection').textContent=
      '服务正在唤醒，首次打开可能需要约一分钟';
  });

restore();
