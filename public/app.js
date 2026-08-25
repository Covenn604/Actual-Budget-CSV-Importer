const S={profiles:[],jobs:[],config:null,actual:{},accounts:[],budgets:[]},
$=x=>document.getElementById(x),
esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

async function api(url,options={}){
  const response=await fetch(url,options);
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(body.error||`Request failed ${response.status}`);
  return body;
}

async function loadProfiles(){
  S.profiles=await api("/api/profiles");
  renderProfiles();
  renderMappings();
}

async function loadActual(){
  S.actual=await api("/api/actual/settings");
  $("actualURL").value=S.actual.serverURL||"";
  $("syncId").value=S.actual.syncId||"";

  // Show the previously selected budget immediately, even before a new
  // discovery request. This makes persisted configuration visible after
  // page reload/container restart.
  if(S.actual.syncId){
    const known=S.budgets.some(b=>b.syncId===S.actual.syncId);
    if(!known){
      S.budgets.unshift({
        name:S.actual.budgetName||"Saved budget",
        syncId:S.actual.syncId,
        encrypted:S.actual.hasEncryptionPassword||false,
        saved:true
      });
    }
    renderBudgetSelect();
  }

  renderMappings();
}

loadProfiles();
loadActual();

document.querySelectorAll(".tab").forEach(button=>{
  button.onclick=async()=>{
    document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));
    button.classList.add("active");

    ["convert","profiles","actual"].forEach(tab=>{
      $(tab+"Tab").classList.toggle("hidden",tab!==button.dataset.tab);
    });

    if(button.dataset.tab==="actual"){
      // If connection details were previously saved, refresh discovered
      // budgets automatically. The saved selection is already visible even
      // if this network refresh fails.
      if(S.actual.serverURL && S.actual.hasPassword){
        await discoverBudgets(false);
      }
      if(S.actual.syncId){
        await refreshAccounts(false);
      }
    }
  };
});

const drop=$("drop"),files=$("files");

drop.onclick=()=>files.click();
files.onchange=e=>handleFiles([...e.target.files]);

["dragenter","dragover"].forEach(eventName=>{
  drop.addEventListener(eventName,e=>{
    e.preventDefault();
    drop.classList.add("over");
  });
});

["dragleave","drop"].forEach(eventName=>{
  drop.addEventListener(eventName,e=>{
    e.preventDefault();
    drop.classList.remove("over");
  });
});

drop.ondrop=e=>handleFiles([...e.dataTransfer.files]);

async function inspect(file){
  const data=new FormData();
  data.append("file",file);
  return api("/api/inspect",{method:"POST",body:data});
}

async function handleFiles(list){
  for(const file of list.filter(f=>/\.csv$/i.test(f.name))){
    const job={
      file,
      status:"Inspecting",
      inspection:null,
      profile:null,
      result:null,
      error:null,
      dryRun:null,
      imported:null
    };

    S.jobs.push(job);
    renderJobs();

    try{
      job.inspection=await inspect(file);

      if(job.inspection.detectedProfile){
        job.profile=job.inspection.detectedProfile;
        await convertJob(job);
      }else{
        job.status="Needs profile configuration";
      }
    }catch(e){
      job.error=e.message;
    }

    renderJobs();
  }
}

async function convertJob(job,profile=job.profile){
  const data=new FormData();
  data.append("file",job.file);
  data.append("profile",JSON.stringify(profile));
  data.append("headerIndex",job.inspection.headerIndex);

  job.result=await api("/api/convert",{method:"POST",body:data});
  job.profile=profile;
  job.status=`Ready · ${job.result.rows.length} transactions`;
}

function renderJobs(){
  $("jobs").innerHTML=S.jobs.map((job,index)=>`
    <div class="job">
      <div class="jobhead">
        <div>
          <strong>${esc(job.file.name)}</strong>
          <p>${esc(job.status)}</p>
          ${job.profile?`<span class="pill">${esc(job.profile.name)}</span>`:""}
        </div>
        <div class="${job.error?"bad":job.result?"good":"warn"}">
          ${job.error?esc(job.error):job.imported?"Imported":job.result?"Converted":"Pending"}
        </div>
      </div>

      ${job.error?`<div class="notice bad">${esc(job.error)}</div>`:""}

      ${!job.profile&&job.inspection?`
        <div class="notice">
          Unknown format. Configure it once and future matching files will be detected.
        </div>
        <div class="actions">
          <button onclick="configure(${index})">Configure profile</button>
        </div>
      `:""}

      ${job.result?renderResult(job,index):""}
    </div>
  `).join("");
}

function renderResult(job,index){
  const mapped=S.actual.accountMappings?.[job.profile.id];

  const safety=job.dryRun?.safety;
  const actualRun=job.dryRun?.actual;

  const safetyHtml=safety ? `
    <div class="safety-panel">
      <h3>Duplicate safety preflight</h3>

      <div class="safety-stats">
        <div><strong>${safety.counts.definiteDuplicate}</strong><span>Definite duplicates</span></div>
        <div><strong>${safety.counts.likelyDuplicate}</strong><span>Likely duplicates</span></div>
        <div><strong>${safety.counts.possibleDuplicate}</strong><span>Possible matches</span></div>
        <div><strong>${safety.counts.new}</strong><span>New / safe</span></div>
      </div>

      <div class="notice ${safety.counts.likelyDuplicate || safety.counts.possibleDuplicate ? "warn" : "good"}">
        Safe mode will submit only the ${safety.eligibleForSafeImport} transaction(s)
        classified as <strong>new</strong>. Definite, likely, and possible
        duplicates are skipped.
      </div>

      ${actualRun ? `
        <div class="notice">
          Actual reconciliation on the safe subset:
          ${actualRun.added} add,
          ${actualRun.updated} update,
          ${actualRun.errors} error(s).
        </div>
      ` : ""}

      <details>
        <summary>Review duplicate analysis</summary>
        <div class="tablewrap">
          <table class="safety-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Incoming</th>
                <th>Existing match</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              ${safety.rows.map(row=>`
                <tr>
                  <td><span class="match ${row.classification}">${formatClassification(row.classification)}</span></td>
                  <td>
                    ${esc(row.incoming.date)} ·
                    ${Number(row.incoming.amount).toFixed(2)} ·
                    ${esc(row.incoming.description)}
                  </td>
                  <td>
                    ${row.existing
                      ? `${esc(row.existing.date)} · ${Number(row.existing.amount).toFixed(2)} · ${esc(row.existing.payee||"(no payee)")}`
                      : "—"
                    }
                  </td>
                  <td>${esc(row.reason)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </details>

      ${safety.eligibleForSafeImport > 0 && actualRun?.errors === 0
        ? `<div class="actions"><button onclick="doImport(${index})">Confirm safe import (${safety.eligibleForSafeImport})</button></div>`
        : `<div class="notice">No transactions are currently eligible for safe import.</div>`
      }
    </div>
  ` : "";

  return `
    ${job.result.warnings.length?`
      <div class="notice warn">${job.result.warnings.map(esc).join("<br>")}</div>
    `:""}

    <div class="tablewrap">
      <table>
        <thead><tr><th>Date</th><th>Amount</th><th>Description</th></tr></thead>
        <tbody>
          ${job.result.rows.slice(0,80).map(row=>`
            <tr>
              <td>${esc(row.date)}</td>
              <td class="amount">${Number(row.amount).toFixed(2)}</td>
              <td>${esc(row.description)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>

    <div class="actions">
      <button onclick="downloadJob(${index})">Download Actual CSV</button>

      ${mapped
        ? `<button class="secondary" onclick="dryRun(${index})">Analyze duplicates + preview import</button>`
        : `<span class="notice">Map this profile to an Actual account to enable direct import.</span>`
      }
    </div>

    ${safetyHtml}

    ${job.imported?`
      <div class="notice good">
        Import complete:
        ${job.imported.added} added,
        ${job.imported.updated} updated,
        ${job.imported.errors} error(s).
        Skipped for safety:
        ${job.imported.skippedDefinite} definite,
        ${job.imported.skippedLikely} likely,
        ${job.imported.skippedPossible} possible.
      </div>
    `:""}
  `;
}

function formatClassification(value){
  return ({
    definiteDuplicate:"Definite duplicate",
    likelyDuplicate:"Likely duplicate",
    possibleDuplicate:"Possible match",
    new:"New"
  })[value] || value;
}

window.downloadJob=index=>{
  const job=S.jobs[index];

  const quote=value=>{
    const s=String(value);
    return /[",\r\n]/.test(s)
      ? `"${s.replace(/"/g,'""')}"`
      : s;
  };

  const lines=["Transaction Date,Transaction Amount,Description"];

  job.result.rows.forEach(row=>{
    lines.push(
      [row.date,Number(row.amount).toFixed(2),row.description]
        .map(quote)
        .join(",")
    );
  });

  const blob=new Blob(
    ["\uFEFF"+lines.join("\r\n")+"\r\n"],
    {type:"text/csv"}
  );

  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download=`Actual_${job.profile.name.replace(/[^a-z0-9]+/gi,"_")}.csv`;
  a.click();
};

window.dryRun=async index=>{
  const job=S.jobs[index];

  try{
    job.error=null;
    job.status="Analyzing existing Actual transactions…";
    renderJobs();

    const response=await api("/api/actual/dry-run",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        profileId:job.profile.id,
        rows:job.result.rows
      })
    });

    job.dryRun={
      safety:response.safety,
      actual:response.actual
    };
    job.status=`Ready · ${job.result.rows.length} source transactions`;
    job.error=null;
    renderJobs();
  }catch(e){
    job.error=e.message;
    job.status="Duplicate analysis failed";
    renderJobs();
  }
};

window.doImport=async index=>{
  const job=S.jobs[index];
  const eligible=job.dryRun?.safety?.eligibleForSafeImport || 0;

  if(!eligible){
    return;
  }

  if(!confirm(
    `Safe mode will import ${eligible} transaction(s). `+
    `Transactions classified as definite, likely, or possible duplicates will be skipped. Continue?`
  )){
    return;
  }

  try{
    const response=await api("/api/actual/import",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        profileId:job.profile.id,
        rows:job.result.rows,
        confirm:true
      })
    });

    job.imported=response.summary;
    job.dryRun=null;
    job.error=null;
    job.status="Safe import complete";
    renderJobs();
  }catch(e){
    job.error=e.message;
    renderJobs();
  }
};

/* Profile mapper */

function fillSelect(id,headers,blank=false){
  $(id).innerHTML=
    (blank?'<option value="">— None —</option>':"")+
    headers.map(x=>`<option>${esc(x)}</option>`).join("");
}

window.configure=index=>{
  const job=S.jobs[index];
  S.config=index;

  $("mapperFile").textContent=job.file.name;
  $("profileName").value="";

  ["mapDate","mapDescription","mapAmount"]
    .forEach(id=>fillSelect(id,job.inspection.headers));

  ["mapDebit","mapCredit","mapImportedId"]
    .forEach(id=>fillSelect(id,job.inspection.headers,true));

  guessMappings(job.inspection.headers);

  $("mapperPreview").innerHTML=`
    <table>
      <thead>
        <tr>${job.inspection.headers.map(h=>`<th>${esc(h)}</th>`).join("")}</tr>
      </thead>
      <tbody>
        ${job.inspection.sampleRows.map(row=>`
          <tr>
            ${job.inspection.headers.map((_,i)=>`<td>${esc(row[i]||"")}</td>`).join("")}
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  $("mapperMessage").innerHTML="";
  $("mapper").showModal();
};

function guessMappings(headers){
  const lower=headers.map(x=>x.toLowerCase());

  const pick=(id,terms)=>{
    const i=lower.findIndex(x=>terms.some(term=>x.includes(term)));
    if(i>=0)$(id).value=headers[i];
  };

  pick("mapDate",["date"]);
  pick("mapDescription",["description","merchant","payee","memo"]);
  pick("mapAmount",["amount"]);
  pick("mapDebit",["debit","withdrawal"]);
  pick("mapCredit",["credit","deposit"]);
  pick("mapImportedId",["transaction id","reference","fitid","unique id"]);
}

$("amountMode").onchange=()=>{
  const debitCredit=$("amountMode").value==="debit-credit";

  document.querySelectorAll(".dc")
    .forEach(x=>x.classList.toggle("hidden",!debitCredit));

  $("singleAmountWrap").classList.toggle("hidden",debitCredit);
  $("singleSignWrap").classList.toggle("hidden",debitCredit);
};

function currentProfile(){
  const mode=$("amountMode").value;

  const profile={
    name:$("profileName").value.trim(),
    delimiter:",",
    dateFormat:$("dateFormat").value,
    amountMode:mode,
    singleAmountSign:$("singleAmountSign").value,
    actualImportSign:$("actualImportSign").value,
    mapping:{
      date:$("mapDate").value,
      description:$("mapDescription").value
    },
    match:{requiredHeaders:[]}
  };

  if($("mapImportedId").value){
    profile.mapping.importedId=$("mapImportedId").value;
  }

  if(mode==="single"){
    profile.mapping.amount=$("mapAmount").value;
    profile.match.requiredHeaders=[
      profile.mapping.date,
      profile.mapping.description,
      profile.mapping.amount
    ];
  }else{
    profile.mapping.debit=$("mapDebit").value;
    profile.mapping.credit=$("mapCredit").value;

    profile.match.requiredHeaders=[
      profile.mapping.date,
      profile.mapping.description,
      profile.mapping.debit,
      profile.mapping.credit
    ].filter(Boolean);
  }

  if(profile.mapping.importedId){
    profile.match.requiredHeaders.push(profile.mapping.importedId);
  }

  return profile;
}

async function testCurrentProfile(){
  const job=S.jobs[S.config];
  const profile=currentProfile();

  if(!profile.name){
    throw Error("Enter a profile name.");
  }

  const data=new FormData();
  data.append("file",job.file);
  data.append("profile",JSON.stringify(profile));
  data.append("headerIndex",job.inspection.headerIndex);

  return api("/api/convert",{method:"POST",body:data});
}

$("testMapping").onclick=async()=>{
  try{
    const result=await testCurrentProfile();

    $("mapperMessage").innerHTML=`
      <div class="notice good">
        Mapping works: ${result.rows.length} transactions.
      </div>
    `;
  }catch(e){
    $("mapperMessage").innerHTML=`
      <div class="notice bad">${esc(e.message)}</div>
    `;
  }
};

$("saveProfile").onclick=async()=>{
  try{
    const job=S.jobs[S.config];
    const profile=currentProfile();
    const result=await testCurrentProfile();

    const saved=await api("/api/profiles",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(profile)
    });

    job.profile=saved;
    job.result=result;
    job.status=`Ready · ${result.rows.length} transactions`;

    $("mapper").close();

    await loadProfiles();
    renderJobs();
  }catch(e){
    $("mapperMessage").innerHTML=`
      <div class="notice bad">${esc(e.message)}</div>
    `;
  }
};

function renderProfiles(){
  $("profileList").innerHTML=S.profiles.map(profile=>`
    <div class="profilecard">
      <h2>${esc(profile.name)}</h2>
      <p>${esc(profile.amountMode)} · ${esc(profile.dateFormat)}</p>
      <p>Direct Actual sign: <strong>${esc(profile.actualImportSign || "preserve")}</strong></p>

      <div class="actions">
        <button class="secondary" onclick="exportProfile('${esc(profile.id)}')">
          Export JSON
        </button>

        <button class="secondary" onclick="deleteProfile('${esc(profile.id)}','${esc(profile.name)}')">
          Delete
        </button>
      </div>
    </div>
  `).join("");
}

window.exportProfile=id=>{
  location.href=`/api/profiles/${encodeURIComponent(id)}/export`;
};

window.deleteProfile=async(id,name)=>{
  if(confirm(`Delete "${name}"?`)){
    await api(`/api/profiles/${encodeURIComponent(id)}`,{
      method:"DELETE"
    });

    await loadProfiles();
    await loadActual();
  }
};

$("profileImport").onchange=async event=>{
  const file=event.target.files[0];
  if(!file)return;

  const data=new FormData();
  data.append("profile",file);

  try{
    await api("/api/profiles/import",{
      method:"POST",
      body:data
    });

    await loadProfiles();
  }catch(e){
    alert(e.message);
  }

  event.target.value="";
};

/* Actual setup */

$("saveActual").onclick=async()=>{
  try{
    await api("/api/actual/settings",{
      method:"PUT",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        serverURL:$("actualURL").value,
        password:$("actualPassword").value,
        encryptionPassword:$("encryptionPassword").value
      })
    });

    $("actualPassword").value="";
    $("encryptionPassword").value="";

    await loadActual();

    $("actualMessage").innerHTML=`
      <div class="notice good">Connection settings saved locally.</div>
    `;
  }catch(e){
    $("actualMessage").innerHTML=`
      <div class="notice bad">${esc(e.message)}</div>
    `;
  }
};

async function discoverBudgets(showMessage=true){
  try{
    if(showMessage){
      $("actualMessage").innerHTML=`
        <div class="notice">Connecting to Actual and discovering budgets…</div>
      `;
    }

    const discovered=await api("/api/actual/budgets");

    // Server already deduplicates by Sync ID. Keep the current saved budget
    // visible if for some reason it is not returned by discovery.
    S.budgets=discovered;

    if(S.actual.syncId && !S.budgets.some(b=>b.syncId===S.actual.syncId)){
      S.budgets.unshift({
        name:S.actual.budgetName||"Saved budget",
        syncId:S.actual.syncId,
        encrypted:S.actual.hasEncryptionPassword||false,
        saved:true
      });
    }

    renderBudgetSelect();

    if(showMessage){
      $("actualMessage").innerHTML=`
        <div class="notice good">
          Connected. ${discovered.length} budget(s) found.
        </div>
      `;
    }

    return true;
  }catch(e){
    // Do not erase the persisted budget just because discovery temporarily
    // fails. Keep the last known selection visible.
    if(S.actual.syncId){
      S.budgets=[{
        name:S.actual.budgetName||"Saved budget",
        syncId:S.actual.syncId,
        encrypted:S.actual.hasEncryptionPassword||false,
        saved:true
      }];
      renderBudgetSelect();
    }

    if(showMessage){
      $("actualMessage").innerHTML=`
        <div class="notice bad">${esc(e.message)}</div>
      `;
    }

    return false;
  }
}

$("discoverBudgets").onclick=()=>discoverBudgets(true);

function renderBudgetSelect(){
  const selected=S.actual.syncId||"";

  $("budgetSelect").innerHTML=
    '<option value="">— Select a budget —</option>'+
    S.budgets.map(budget=>`
      <option
        value="${esc(budget.syncId)}"
        ${selected===budget.syncId?"selected":""}
      >
        ${esc(budget.name)}${budget.encrypted?" (encrypted)":""}
      </option>
    `).join("");

  if(selected){
    $("syncId").value=selected;
  }
}

$("budgetSelect").onchange=()=>{
  $("syncId").value=$("budgetSelect").value||"";
};

$("selectBudget").onclick=async()=>{
  try{
    const syncId=$("budgetSelect").value;

    if(!syncId){
      throw Error("Select a budget first.");
    }

    const budget=S.budgets.find(b=>b.syncId===syncId);

    await api("/api/actual/select-budget",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        syncId,
        budgetName:budget?.name||""
      })
    });

    await loadActual();

    $("budgetMessage").innerHTML=`
      <div class="notice good">
        Selected ${esc(budget?.name||"budget")}.
      </div>
    `;

    await refreshAccounts(false);
  }catch(e){
    $("budgetMessage").innerHTML=`
      <div class="notice bad">${esc(e.message)}</div>
    `;
  }
};

$("testActual").onclick=async()=>{
  try{
    $("budgetMessage").innerHTML=`
      <div class="notice">
        Downloading selected budget and loading accounts…
      </div>
    `;

    const result=await api("/api/actual/test",{
      method:"POST"
    });

    $("budgetMessage").innerHTML=`
      <div class="notice good">
        Connection successful. ${result.accounts} account(s) found.
      </div>
    `;

    await refreshAccounts(false);
  }catch(e){
    $("budgetMessage").innerHTML=`
      <div class="notice bad">${esc(e.message)}</div>
    `;
  }
};

async function refreshAccounts(showError=false){
  try{
    if(!S.actual.syncId){
      S.accounts=[];
      renderMappings();
      return;
    }

    S.accounts=await api("/api/actual/accounts");
    renderMappings();
  }catch(e){
    S.accounts=[];
    renderMappings();

    if(showError){
      $("budgetMessage").innerHTML=`
        <div class="notice bad">${esc(e.message)}</div>
      `;
    }
  }
}

function renderMappings(){
  if(!$("mappingList"))return;

  if(!S.actual.syncId){
    $("mappingList").innerHTML=`
      <p>Select and test an Actual budget before mapping accounts.</p>
    `;
    return;
  }

  $("mappingList").innerHTML=S.profiles.length
    ? S.profiles.map(profile=>`
        <div class="maprow">
          <strong>${esc(profile.name)}</strong>

          <select onchange="saveMap('${esc(profile.id)}',this.value)">
            <option value="">— Not mapped —</option>

            ${S.accounts
              .filter(account=>!account.closed)
              .map(account=>`
                <option
                  value="${esc(account.id)}"
                  ${S.actual.accountMappings?.[profile.id]===account.id?"selected":""}
                >
                  ${esc(account.name)}${account.offbudget?" (off budget)":""}
                </option>
              `).join("")
            }
          </select>
        </div>
      `).join("")
    : "<p>No profiles yet.</p>";
}

window.saveMap=async(id,accountId)=>{
  await api(`/api/actual/mappings/${encodeURIComponent(id)}`,{
    method:"PUT",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({accountId})
  });

  await loadActual();
  renderJobs();
};
