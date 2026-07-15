import { useState, useEffect, useRef } from "react";
import { db } from "./firebase";
import { collection, doc, setDoc, deleteDoc, onSnapshot } from "firebase/firestore";
import { LOGO_DATA_URI } from "./logo";
import { Camera, Upload, Search, X, Loader2, Truck, Calendar, MapPin, Package, Hash, FileText, Trash2, Check, AlertCircle, ScanLine, User, Plus, ChevronRight, CheckSquare, Square, ListChecks, Building2, ChevronDown } from "lucide-react";


const SHIPMENTS = "shipments";

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function fmtDate(d) {
  if (!d) return "—";
  try {
    const dt = new Date(d + "T00:00:00");
    if (isNaN(dt.getTime())) return d;
    return dt.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
  } catch {
    return d;
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]);
    r.onerror = () => reject(new Error("Read failed"));
    r.readAsDataURL(file);
  });
}

// Resize + compress an image to JPEG so the AI request stays light. Uses
// FileReader as the source (more compatible than createObjectURL in sandboxes).
function compressImage(file, maxDim = 1568, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read image"));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          let { width, height } = img;
          if (!width || !height) throw new Error("Invalid dimensions");
          if (width > maxDim || height > maxDim) {
            if (width >= height) {
              height = Math.round((height * maxDim) / width);
              width = maxDim;
            } else {
              width = Math.round((width * maxDim) / height);
              height = maxDim;
            }
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#FFFFFF";
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);
          const dataUrl = canvas.toDataURL("image/jpeg", quality);
          resolve({ base64: dataUrl.split(",")[1], mediaType: "image/jpeg", previewUrl: dataUrl });
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error("Could not decode image"));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function emptyLine() {
  return { _k: uid(), qty: "", description: "" };
}

function makeEmptyForm() {
  return {
    workOrder: "",
    customer: "",
    lineItems: [emptyLine()],
    destination: "",
    date: "",
    carrier: "",
    trackingNumber: "",
    loggedBy: "",
    notes: "",
    checklist: null,
  };
}

// Normalize a record's items into an array of { qty, description }.
function getLines(record) {
  if (Array.isArray(record?.lineItems) && record.lineItems.length) {
    return record.lineItems.filter((l) => (l.description || "").trim() || (l.qty || "").toString().trim());
  }
  if (record?.item) return [{ qty: "", description: record.item }];
  return [];
}

// Load a record's lines into the form, giving each a stable key for editing.
function linesForForm(record) {
  const lines = getLines(record).map((l) => ({ _k: uid(), qty: l.qty || "", description: l.description || "" }));
  return lines.length ? lines : [emptyLine()];
}

// Standard Day-Nite QC / shipping checklist items (checked off before shipping).
const CHECKLIST_ITEMS = [
  "CSA",
  "# of signs match work order",
  "Verify paint color",
  "Pattern checked & signed",
  "Power supply",
  "If more than 1 power supply",
  "Ensure supply is labeled",
  "Trademark logo",
  "Silicone",
  "Touch-up paint",
  "Install pattern wrapped in plastic",
  "Mounting hardware",
  "Awning Z-clips",
];

function newChecklist() {
  return CHECKLIST_ITEMS.map((label) => ({ label, done: false }));
}

function checklistDone(record) {
  const cl = record?.checklist;
  if (!Array.isArray(cl) || !cl.length) return null;
  return { done: cl.filter((c) => c.done).length, total: cl.length };
}

// Sample shipments for the pitch (based on a real Day-Nite packing list).
const SAMPLE_RECORDS = [
  {
    workOrder: "WO-24817",
    customer: "Tim Hortons",
    lineItems: [
      { qty: "2", description: '42" Tim Hortons letters' },
      { qty: "2", description: "120w power supply" },
      { qty: "2", description: "Trademark logo" },
      { qty: "1", description: "Silicone" },
      { qty: "1", description: "Bag with extra screws" },
    ],
    destination: "640 Ave Lépine, Dorval, QC (H9P 1G2)",
    date: "2026-06-25",
    carrier: "Day & Ross",
    trackingNumber: "WQ593476",
    loggedBy: "Rory MacRae",
    notes: "Tim Hortons #2022 · 83 D'Anjou, Chateauguay QC · crate, 20 lbs",
    checklist: CHECKLIST_ITEMS.map((label) => ({
      label,
      done: !["Awning Z-clips", "Touch-up paint"].includes(label),
    })),
  },
  {
    workOrder: "WO-24790",
    customer: "Irving Oil",
    lineItems: [
      { qty: "1", description: "Channel letters 'OPEN', illuminated, 24×36 in" },
      { qty: "1", description: "Mounting hardware kit" },
    ],
    destination: "Irving Oil — Saint John, NB",
    date: "2026-06-22",
    carrier: "Purolator",
    trackingNumber: "PUR882019473",
    loggedBy: "Rory MacRae",
    notes: "2 boxes · fragile · deliver to rear dock",
  },
  {
    workOrder: "WO-24765",
    customer: "Sobeys",
    lineItems: [
      { qty: "1", description: "Pylon sign face, acrylic (replacement)" },
    ],
    destination: "Sobeys — Truro, NS",
    date: "2026-06-19",
    carrier: "Day & Ross",
    trackingNumber: "WQ591802",
    loggedBy: "K. Doucette",
    notes: "Skid · 65 lbs · call contact before delivery",
  },
];

export default function DispatchLog() {
  const [records, setRecords] = useState([]);
  const [loadingRecords, setLoadingRecords] = useState(true);

  const [view, setView] = useState("list"); // list | scan | form
  const [query, setQuery] = useState("");
  const [customerFilter, setCustomerFilter] = useState("all");
  const [imagePreview, setImagePreview] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [scanNotice, setScanNotice] = useState(null);
  const [seeding, setSeeding] = useState(false);
  const [form, setForm] = useState(makeEmptyForm());
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [detailRecord, setDetailRecord] = useState(null);
  const [lastLoggedBy, setLastLoggedBy] = useState("");

  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, SHIPMENTS),
      (snap) => {
        const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
        setRecords(items);
        setLoadingRecords(false);
      },
      (err) => {
        console.error("Firestore listen failed:", err);
        setLoadingRecords(false);
      }
    );
    return () => unsub();
  }, []);

  async function loadSamples() {
    setSeeding(true);
    try {
      const now = Date.now();
      await Promise.all(
        SAMPLE_RECORDS.map((s, i) => {
          const id = uid();
          const rec = {
            ...s,
            createdAt: new Date(now - i * 1000).toISOString(),
            updatedAt: new Date(now - i * 1000).toISOString(),
          };
          return setDoc(doc(db, SHIPMENTS, id), rec);
        })
      );
    } catch (e) {
      console.error("Seeding failed:", e);
    } finally {
      setSeeding(false);
    }
  }

  function resetScan() {
    setImagePreview(null);
    setScanError(null);
    setScanNotice(null);
    setForm(makeEmptyForm());
    setEditingId(null);
  }

  async function handleFile(file) {
    if (!file) return;
    setScanError(null);
    setScanNotice(null);
    setView("scan");
    try {
      const isPdf = file.type === "application/pdf" || file.name?.toLowerCase().endsWith(".pdf");
      if (isPdf) {
        const base64 = await fileToBase64(file);
        setImagePreview(null);
        runExtraction(base64, "application/pdf", true);
      } else {
        let base64, mediaType, previewUrl;
        try {
          ({ base64, mediaType, previewUrl } = await compressImage(file));
        } catch {
          base64 = await fileToBase64(file);
          mediaType = file.type || "image/jpeg";
          previewUrl = `data:${mediaType};base64,${base64}`;
        }
        setImagePreview(previewUrl);
        runExtraction(base64, mediaType, false);
      }
    } catch (e) {
      setScanNotice(
        "Auto-read isn't available in this preview. In the full version these fields fill in from the photo — for now, type them in."
      );
      setForm((f) => ({ ...f, loggedBy: lastLoggedBy }));
      setView("form");
    }
  }

  async function runExtraction(base64, mediaType, isPdf = false) {
    setScanning(true);
    setScanError(null);
    try {
      const resp = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: base64, mediaType }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || `HTTP ${resp.status}`);

      let lines = Array.isArray(data.lineItems)
        ? data.lineItems
            .map((l) => ({ _k: uid(), qty: (l?.qty ?? "").toString(), description: (l?.description ?? "").toString() }))
            .filter((l) => l.qty.trim() || l.description.trim())
        : [];
      if (!lines.length) lines = [emptyLine()];

      setForm({
        workOrder: data.workOrder || "",
        customer: data.customer || "",
        lineItems: lines,
        destination: data.destination || "",
        date: data.date || "",
        carrier: data.carrier || "",
        trackingNumber: data.trackingNumber || "",
        loggedBy: lastLoggedBy,
        notes: data.notes || "",
        checklist: null,
      });
      setView("form");
    } catch (e) {
      console.error("Scan failed:", e);
      setScanNotice(
        "Couldn't read the document automatically (" + (e?.message || "error") + "). Fill in the fields manually."
      );
      setForm({ ...makeEmptyForm(), loggedBy: lastLoggedBy });
      setView("form");
    } finally {
      setScanning(false);
    }
  }

  function openManualForm() {
    resetScan();
    setForm((f) => ({ ...f, loggedBy: lastLoggedBy }));
    setView("form");
  }

  function openEdit(record) {
    setDetailRecord(null);
    setEditingId(record.id);
    setForm({
      workOrder: record.workOrder || "",
      customer: record.customer || "",
      lineItems: linesForForm(record),
      destination: record.destination || "",
      date: record.date || "",
      carrier: record.carrier || "",
      trackingNumber: record.trackingNumber || "",
      loggedBy: record.loggedBy || "",
      notes: record.notes || "",
      checklist: Array.isArray(record.checklist) ? record.checklist.map((c) => ({ ...c })) : null,
    });
    setImagePreview(null);
    setView("form");
  }

  async function saveRecord() {
    const cleanLines = form.lineItems
      .map((l) => ({ qty: (l.qty || "").trim(), description: (l.description || "").trim() }))
      .filter((l) => l.qty || l.description);
    const hasItems = cleanLines.length > 0;
    if (!hasItems && !form.destination.trim()) {
      setScanError("Add at least one item or a destination.");
      return;
    }
    setSaving(true);
    setScanError(null);
    const id = editingId || uid();
    const existing = editingId ? records.find((r) => r.id === editingId) : null;
    const record = {
      id,
      workOrder: form.workOrder || "",
      customer: form.customer || "",
      lineItems: hasItems ? cleanLines : [],
      destination: form.destination || "",
      date: form.date || "",
      carrier: form.carrier || "",
      trackingNumber: form.trackingNumber || "",
      loggedBy: form.loggedBy || "",
      notes: form.notes || "",
      checklist: Array.isArray(form.checklist) ? form.checklist : null,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const safe = JSON.parse(JSON.stringify(record));

    try {
      await setDoc(doc(db, SHIPMENTS, id), safe);
      if (form.loggedBy.trim()) setLastLoggedBy(form.loggedBy.trim());
      resetScan();
      setView("list");
    } catch (e) {
      console.error("Save failed:", e);
      setScanError("Couldn't save: " + (e?.code || e?.message || "unknown error"));
    } finally {
      setSaving(false);
    }
  }

  function deleteRecord(id) {
    deleteDoc(doc(db, SHIPMENTS, id)).catch((e) => console.error("Delete failed:", e));
    setConfirmDelete(null);
    setDetailRecord(null);
  }

  const customers = Array.from(
    new Set(records.map((r) => (r.customer || "").trim()).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));

  // If the active customer filter no longer matches any record, reset it so the
  // dropdown and the list can't get out of sync (e.g. after deleting/editing).
  const customerKey = customers.join("|");
  useEffect(() => {
    if (customerFilter !== "all" && !customers.includes(customerFilter)) {
      setCustomerFilter("all");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerKey, customerFilter]);

  const filtered = records.filter((r) => {
    if (customerFilter !== "all" && (r.customer || "").trim() !== customerFilter) return false;
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    const itemsText = getLines(r).map((l) => `${l.qty} ${l.description}`).join(" ");
    return (
      itemsText.toLowerCase().includes(q) ||
      (r.workOrder || "").toLowerCase().includes(q) ||
      (r.customer || "").toLowerCase().includes(q) ||
      (r.destination || "").toLowerCase().includes(q) ||
      (r.carrier || "").toLowerCase().includes(q) ||
      (r.trackingNumber || "").toLowerCase().includes(q) ||
      (r.loggedBy || "").toLowerCase().includes(q) ||
      (r.notes || "").toLowerCase().includes(q)
    );
  });

  return (
    <div style={styles.page}>
      <style>{fontImports}</style>
      <Header count={records.length} />

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,.pdf"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          handleFile(f);
          e.target.value = "";
        }}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          handleFile(f);
          e.target.value = "";
        }}
      />

      <main style={styles.main}>
        {view === "list" && (
          <ListView
            loading={loadingRecords}
            records={filtered}
            allCount={records.length}
            query={query}
            setQuery={setQuery}
            customers={customers}
            customerFilter={customerFilter}
            setCustomerFilter={setCustomerFilter}
            onOpen={(r) => setDetailRecord(r)}
            onScan={() => fileInputRef.current?.click()}
            onCamera={() => cameraInputRef.current?.click()}
            onManual={openManualForm}
            onLoadSamples={loadSamples}
            seeding={seeding}
          />
        )}

        {view === "scan" && (
          <ScanView
            imagePreview={imagePreview}
            scanning={scanning}
            onCancel={() => {
              resetScan();
              setView("list");
            }}
          />
        )}

        {view === "form" && (
          <FormView
            form={form}
            setForm={setForm}
            imagePreview={imagePreview}
            saving={saving}
            error={scanError}
            notice={scanNotice}
            isEdit={!!editingId}
            onSave={saveRecord}
            onCancel={() => {
              resetScan();
              setView("list");
            }}
          />
        )}
      </main>

      {detailRecord && (
        <DetailModal
          record={detailRecord}
          onClose={() => setDetailRecord(null)}
          onEdit={() => openEdit(detailRecord)}
          onDelete={() => setConfirmDelete(detailRecord.id)}
        />
      )}

      {confirmDelete && (
        <ConfirmDeleteModal
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => deleteRecord(confirmDelete)}
        />
      )}
    </div>
  );
}

function Header({ count }) {
  return (
    <header style={styles.header}>
      <div style={styles.headerInner}>
        <div style={styles.brandRow}>
          <div style={styles.logoPlate}>
            <img src={LOGO_DATA_URI} alt="Day-Nite Neon Signs" style={styles.logoImg} />
          </div>
          <div style={styles.brandSub}>Shipment log</div>
        </div>
        <div style={styles.headerCount}>
          {count} {count === 1 ? "record" : "records"}
        </div>
      </div>
    </header>
  );
}

function ListView({ loading, records, allCount, query, setQuery, customers, customerFilter, setCustomerFilter, onOpen, onScan, onCamera, onManual, onLoadSamples, seeding }) {
  return (
    <div>
      <div style={styles.actionRow}>
        <button style={styles.primaryBtn} onClick={onCamera}>
          <Camera size={18} />
          Take photo
        </button>
        <button style={styles.secondaryBtn} onClick={onScan}>
          <Upload size={18} />
          Upload file
        </button>
        <button style={styles.ghostBtn} onClick={onManual}>
          Manual
        </button>
      </div>

      <div style={styles.searchWrap}>
        <Search size={16} color="#7C8A93" style={{ flexShrink: 0 }} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by W.O #, item, customer, carrier…"
          style={styles.searchInput}
        />
        {query && (
          <button onClick={() => setQuery("")} style={styles.clearSearchBtn} aria-label="Clear search">
            <X size={14} />
          </button>
        )}
      </div>

      {customers.length > 0 && (
        <div style={styles.filterWrap}>
          <Building2 size={15} color="#7C8A93" style={{ flexShrink: 0 }} />
          <div style={styles.selectWrap}>
            <select
              value={customerFilter}
              onChange={(e) => setCustomerFilter(e.target.value)}
              style={styles.select}
            >
              <option value="all">All customers</option>
              {customers.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <ChevronDown size={15} color="#7C8A93" style={styles.selectChevron} />
          </div>
          {customerFilter !== "all" && (
            <button style={styles.clearFilterBtn} onClick={() => setCustomerFilter("all")}>
              Clear
            </button>
          )}
        </div>
      )}

      {loading ? (
        <div style={styles.emptyState}>
          <Loader2 size={22} style={{ animation: "spin 1s linear infinite" }} />
          <div style={{ marginTop: 10 }}>Loading log…</div>
        </div>
      ) : records.length === 0 ? (
        <div style={styles.emptyState}>
          <Package size={28} color="#3D4F58" />
          <div style={{ fontWeight: 600, marginTop: 12, color: "#1B2430" }}>
            {allCount === 0 ? "No shipments logged yet" : "No results"}
          </div>
          <div style={{ color: "#7C8A93", fontSize: 13, marginTop: 4 }}>
            {allCount === 0
              ? "Take a photo of the receipt or packing list, or type it in manually."
              : "Try a different search or customer filter."}
          </div>
          {allCount === 0 && (
            <button
              style={{ ...styles.secondaryBtn, flex: "none", marginTop: 18 }}
              onClick={onLoadSamples}
              disabled={seeding}
            >
              {seeding ? <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> : <Package size={16} />}
              Load examples
            </button>
          )}
        </div>
      ) : (
        <div style={styles.cardList}>
          {records.map((r) => (
            <RecordCard key={r.id} record={r} onOpen={() => onOpen(r)} />
          ))}
        </div>
      )}
    </div>
  );
}

function RecordCard({ record, onOpen }) {
  const lines = getLines(record);
  const first = lines[0];
  const extra = lines.length - 1;
  const qc = checklistDone(record);
  return (
    <button style={styles.ticket} onClick={onOpen}>
      <div style={styles.ticketStub}>
        <div style={styles.stampCircle}>OUT</div>
      </div>
      <div style={styles.ticketBody}>
        {(record.workOrder || record.customer) && (
          <div style={styles.tagRow}>
            {record.workOrder && (
              <div style={styles.woTag}>
                <Hash size={11} />
                {record.workOrder}
              </div>
            )}
            {record.customer && (
              <div style={styles.customerTag}>
                <Building2 size={11} />
                {record.customer}
              </div>
            )}
          </div>
        )}
        <div style={styles.ticketTopRow}>
          <div style={styles.ticketItem}>
            {first ? (
              <>
                {first.qty && <span style={styles.qtyBadge}>{first.qty}×</span>}
                {first.description || "Untitled"}
              </>
            ) : (
              "No items"
            )}
          </div>
          <div style={styles.ticketDate}>
            <Calendar size={12} />
            {fmtDate(record.date)}
          </div>
        </div>
        {extra > 0 && (
          <div style={styles.moreItems}>
            +{extra} more {extra === 1 ? "item" : "items"}
          </div>
        )}
        <div style={styles.ticketMetaRow}>
          <MapPin size={12} color="#7C8A93" />
          <span style={styles.ticketMetaText}>{record.destination || "No destination"}</span>
        </div>
        <div style={styles.ticketMetaRow}>
          <Truck size={12} color="#7C8A93" />
          <span style={styles.ticketMetaText}>{record.carrier || "No carrier"}</span>
          {record.trackingNumber && (
            <>
              <span style={styles.dot}>·</span>
              <Hash size={11} color="#7C8A93" />
              <span style={{ ...styles.ticketMetaText, fontFamily: "'IBM Plex Mono', monospace" }}>
                {record.trackingNumber}
              </span>
            </>
          )}
        </div>
        <div style={styles.ticketFooter}>
          <span style={styles.footerLeft}>
            {record.loggedBy && (
              <span style={styles.loggedByText}>
                <User size={11} color="#A0ABB1" />
                {record.loggedBy}
              </span>
            )}
            {qc && (
              <span style={{ ...styles.qcPill, ...(qc.done === qc.total ? styles.qcPillDone : {}) }}>
                <ListChecks size={11} />
                QC {qc.done}/{qc.total}
              </span>
            )}
          </span>
          <span style={styles.viewLink}>
            Details
            <ChevronRight size={13} />
          </span>
        </div>
      </div>
    </button>
  );
}

function ScanView({ imagePreview, scanning, onCancel }) {
  return (
    <div style={styles.scanWrap}>
      {imagePreview && <img src={imagePreview} alt="Scanned document" style={styles.scanImage} />}
      <div style={styles.scanOverlay}>
        <div style={styles.scanLineWrap}>
          <ScanLine size={20} color="#FFB22C" style={{ animation: scanning ? "pulse 1.4s ease-in-out infinite" : "none" }} />
        </div>
        <div style={styles.scanText}>{scanning ? "Reading document…" : "Processing…"}</div>
        <div style={styles.scanSubtext}>Pulling items, destination, date and carrier</div>
      </div>
      <button style={styles.cancelScanBtn} onClick={onCancel}>
        <X size={16} />
        Cancel
      </button>
    </div>
  );
}

function Field({ label, icon, children }) {
  return (
    <label style={styles.fieldLabel}>
      <div style={styles.fieldLabelRow}>
        {icon}
        {label}
      </div>
      {children}
    </label>
  );
}

function FormView({ form, setForm, imagePreview, saving, error, notice, isEdit, onSave, onCancel }) {
  function update(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }
  function updateLine(idx, key, value) {
    setForm((f) => {
      const lineItems = f.lineItems.map((l, i) => (i === idx ? { ...l, [key]: value } : l));
      return { ...f, lineItems };
    });
  }
  function addLine() {
    setForm((f) => ({ ...f, lineItems: [...f.lineItems, emptyLine()] }));
  }
  function removeLine(idx) {
    setForm((f) => {
      const lineItems = f.lineItems.filter((_, i) => i !== idx);
      return { ...f, lineItems: lineItems.length ? lineItems : [emptyLine()] };
    });
  }
  function addChecklist() {
    setForm((f) => ({ ...f, checklist: newChecklist() }));
  }
  function removeChecklist() {
    setForm((f) => ({ ...f, checklist: null }));
  }
  function toggleCheck(idx) {
    setForm((f) => ({
      ...f,
      checklist: f.checklist.map((c, i) => (i === idx ? { ...c, done: !c.done } : c)),
    }));
  }

  return (
    <div>
      {imagePreview && (
        <div style={styles.formImageWrap}>
          <img src={imagePreview} alt="Document" style={styles.formImage} />
        </div>
      )}

      {notice && (
        <div style={styles.infoBanner}>
          <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{notice}</span>
        </div>
      )}

      {error && (
        <div style={styles.errorBanner}>
          <AlertCircle size={16} />
          {error}
        </div>
      )}

      <div style={styles.woCard}>
        <div style={styles.woLabel}>
          <Hash size={14} color="#8A6320" />
          Work Order #
        </div>
        <input
          style={styles.woInput}
          value={form.workOrder}
          onChange={(e) => update("workOrder", e.target.value)}
          placeholder="e.g. WO-24817"
          autoFocus
        />
      </div>

      <div style={{ ...styles.formCard, marginTop: 12 }}>
        <div style={styles.fieldLabelRow}>
          <Package size={13} color="#7C8A93" />
          Items
        </div>
        <div style={styles.lineHeader}>
          <span style={{ width: 56 }}>Qty</span>
          <span>Description</span>
        </div>
        {form.lineItems.map((li, idx) => (
          <div key={li._k || idx} style={styles.lineRow}>
            <input
              style={styles.qtyInput}
              value={li.qty}
              onChange={(e) => updateLine(idx, "qty", e.target.value)}
              placeholder="2"
              inputMode="numeric"
            />
            <input
              style={styles.lineDescInput}
              value={li.description}
              onChange={(e) => updateLine(idx, "description", e.target.value)}
              placeholder='e.g. 42" Tim Hortons letters'
            />
            <button
              style={styles.removeLineBtn}
              onClick={() => removeLine(idx)}
              aria-label="Remove item"
            >
              <X size={15} />
            </button>
          </div>
        ))}
        <button style={styles.addLineBtn} onClick={addLine}>
          <Plus size={15} />
          Add item
        </button>
      </div>

      <div style={{ ...styles.formCard, marginTop: 12 }}>
        <Field label="Customer" icon={<Building2 size={13} color="#7C8A93" />}>
          <input
            style={styles.input}
            value={form.customer}
            onChange={(e) => update("customer", e.target.value)}
            placeholder="e.g. Tim Hortons"
          />
        </Field>

        <Field label="Destination" icon={<MapPin size={13} color="#7C8A93" />}>
          <input
            style={styles.input}
            value={form.destination}
            onChange={(e) => update("destination", e.target.value)}
            placeholder="Ship-to / address"
          />
        </Field>

        <div style={styles.fieldRow}>
          <Field label="Date" icon={<Calendar size={13} color="#7C8A93" />}>
            <input type="date" style={styles.input} value={form.date} onChange={(e) => update("date", e.target.value)} />
          </Field>
          <Field label="Carrier" icon={<Truck size={13} color="#7C8A93" />}>
            <input
              style={styles.input}
              value={form.carrier}
              onChange={(e) => update("carrier", e.target.value)}
              placeholder="Purolator, Day & Ross…"
            />
          </Field>
        </div>

        <Field label="Tracking number" icon={<Hash size={13} color="#7C8A93" />}>
          <input
            style={{ ...styles.input, fontFamily: "'IBM Plex Mono', monospace" }}
            value={form.trackingNumber}
            onChange={(e) => update("trackingNumber", e.target.value)}
            placeholder="Optional"
          />
        </Field>

        <Field label="Logged by" icon={<User size={13} color="#7C8A93" />}>
          <input
            style={styles.input}
            value={form.loggedBy}
            onChange={(e) => update("loggedBy", e.target.value)}
            placeholder="Your name"
          />
        </Field>

        <Field label="Notes" icon={<FileText size={13} color="#7C8A93" />}>
          <textarea
            style={{ ...styles.input, minHeight: 70, resize: "vertical" }}
            value={form.notes}
            onChange={(e) => update("notes", e.target.value)}
            placeholder="Order number, weight, special instructions, etc."
          />
        </Field>
      </div>

      <div style={{ ...styles.formCard, marginTop: 12 }}>
        <div style={styles.checklistHead}>
          <div style={styles.fieldLabelRow}>
            <ListChecks size={13} color="#7C8A93" />
            QC checklist
          </div>
          {form.checklist ? (
            <button style={styles.removeChecklistBtn} onClick={removeChecklist}>
              Remove
            </button>
          ) : null}
        </div>

        {form.checklist ? (
          <div style={styles.checkList}>
            {form.checklist.map((c, idx) => (
              <button key={idx} style={styles.checkRow} onClick={() => toggleCheck(idx)}>
                {c.done ? (
                  <CheckSquare size={19} color="#1B2430" style={{ flexShrink: 0 }} />
                ) : (
                  <Square size={19} color="#B7AF9C" style={{ flexShrink: 0 }} />
                )}
                <span style={{ ...styles.checkLabel, color: c.done ? "#1B2430" : "#5A6670" }}>
                  {c.label}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <button style={styles.addLineBtn} onClick={addChecklist}>
            <Plus size={15} />
            Add QC checklist
          </button>
        )}
      </div>

      <div style={styles.formActions}>
        <button style={styles.ghostBtn} onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button style={styles.primaryBtn} onClick={onSave} disabled={saving}>
          {saving ? <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> : <Check size={16} />}
          {isEdit ? "Save changes" : "Log shipment"}
        </button>
      </div>
    </div>
  );
}

function DetailModal({ record, onClose, onEdit, onDelete }) {
  const lines = getLines(record);
  const qc = checklistDone(record);
  return (
    <div style={styles.modalBackdrop} onClick={onClose}>
      <div style={styles.detailCard} onClick={(e) => e.stopPropagation()}>
        <div style={styles.detailHeader}>
          <div style={styles.detailStamp}>OUT</div>
          <div style={{ flex: 1 }}>
            <div style={styles.detailTagRow}>
              {record.workOrder && (
                <div style={styles.detailWo}>
                  <Hash size={12} />
                  {record.workOrder}
                </div>
              )}
              {record.customer && (
                <div style={styles.detailCustomer}>
                  <Building2 size={12} />
                  {record.customer}
                </div>
              )}
            </div>
            <div style={styles.detailTitle}>{record.destination || "No destination"}</div>
            <div style={styles.detailDate}>
              <Calendar size={12} />
              {fmtDate(record.date)}
            </div>
          </div>
          <button style={styles.closeBtn} onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div style={styles.detailBody}>
          <div style={styles.detailSectionLabel}>Items</div>
          {lines.length ? (
            <div style={styles.itemTable}>
              {lines.map((l, i) => (
                <div key={i} style={styles.itemRow}>
                  <span style={styles.itemQty}>{l.qty || "—"}</span>
                  <span style={styles.itemDesc}>{l.description}</span>
                </div>
              ))}
            </div>
          ) : (
            <div style={styles.detailEmpty}>No items listed</div>
          )}

          <div style={styles.detailGrid}>
            <DetailField icon={<Truck size={13} color="#7C8A93" />} label="Carrier" value={record.carrier} />
            <DetailField
              icon={<Hash size={13} color="#7C8A93" />}
              label="Tracking"
              value={record.trackingNumber}
              mono
            />
            <DetailField icon={<User size={13} color="#7C8A93" />} label="Logged by" value={record.loggedBy} />
          </div>

          {qc && (
            <div style={styles.detailNotes}>
              <div style={styles.detailSectionLabel}>
                QC checklist · {qc.done}/{qc.total} complete
              </div>
              <div style={styles.itemTable}>
                {record.checklist.map((c, i) => (
                  <div key={i} style={styles.itemRow}>
                    {c.done ? (
                      <CheckSquare size={17} color="#1B2430" style={{ flexShrink: 0 }} />
                    ) : (
                      <Square size={17} color="#B7AF9C" style={{ flexShrink: 0 }} />
                    )}
                    <span style={{ ...styles.itemDesc, color: c.done ? "#1B2430" : "#8A8170" }}>
                      {c.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {record.notes && (
            <div style={styles.detailNotes}>
              <div style={styles.detailSectionLabel}>Notes</div>
              <div style={styles.detailNotesText}>{record.notes}</div>
            </div>
          )}
        </div>

        <div style={styles.detailActions}>
          <button style={{ ...styles.ghostBtn, color: "#B3493F", borderColor: "#E3B4AC" }} onClick={onDelete}>
            <Trash2 size={14} />
            Delete
          </button>
          <button style={styles.primaryBtn} onClick={onEdit}>
            Edit
          </button>
        </div>
      </div>
    </div>
  );
}

function DetailField({ icon, label, value, mono }) {
  return (
    <div style={styles.detailField}>
      <div style={styles.detailFieldLabel}>
        {icon}
        {label}
      </div>
      <div style={{ ...styles.detailFieldValue, fontFamily: mono ? "'IBM Plex Mono', monospace" : "inherit" }}>
        {value || "—"}
      </div>
    </div>
  );
}

function ConfirmDeleteModal({ onCancel, onConfirm }) {
  return (
    <div style={{ ...styles.modalBackdrop, zIndex: 60 }} onClick={onCancel}>
      <div style={styles.modalCard} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 15, color: "#1B2430" }}>Delete this record?</div>
        <div style={{ color: "#7C8A93", fontSize: 13, marginTop: 6 }}>
          This can't be undone. The record is removed for everyone.
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
          <button style={{ ...styles.ghostBtn, flex: 1 }} onClick={onCancel}>
            Cancel
          </button>
          <button style={{ ...styles.primaryBtn, flex: 1, background: "#B3493F" }} onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

const fontImports = `
@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@400;500;600&display=swap');
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
* { box-sizing: border-box; }
input::placeholder, textarea::placeholder { color: #A0ABB1; }
input:focus, textarea:focus { outline: 2px solid #FFB22C; outline-offset: 1px; }
button:focus-visible { outline: 2px solid #FFB22C; outline-offset: 2px; }
button { font-family: inherit; cursor: pointer; }
button:disabled { opacity: 0.6; cursor: not-allowed; }
`;

const styles = {
  page: { minHeight: "100vh", background: "#ECE8DE", fontFamily: "'Inter', sans-serif", color: "#1B2430" },
  header: { background: "#1B2430", borderBottom: "3px solid #FFB22C" },
  headerInner: {
    maxWidth: 640,
    margin: "0 auto",
    padding: "16px 18px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  brandRow: { display: "flex", alignItems: "center", gap: 12 },
  logoPlate: { background: "#F4F1EA", borderRadius: 6, padding: "6px 10px", display: "flex", alignItems: "center", lineHeight: 0 },
  logoImg: { height: 22, width: "auto", display: "block" },
  brandSub: { fontSize: 11.5, color: "#8FA3AC", letterSpacing: 0.3 },
  headerCount: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 11.5,
    color: "#8FA3AC",
    border: "1px solid #3D4F58",
    borderRadius: 20,
    padding: "5px 11px",
  },
  main: { maxWidth: 640, margin: "0 auto", padding: "18px 18px 60px" },
  actionRow: { display: "flex", gap: 8, marginBottom: 14 },
  primaryBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    background: "#1B2430",
    color: "#F4F1EA",
    border: "none",
    borderRadius: 8,
    padding: "11px 16px",
    fontSize: 13.5,
    fontWeight: 600,
    flex: 1,
  },
  secondaryBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    background: "#F4F1EA",
    color: "#1B2430",
    border: "1.5px solid #1B2430",
    borderRadius: 8,
    padding: "11px 16px",
    fontSize: 13.5,
    fontWeight: 600,
    flex: 1,
  },
  ghostBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    background: "transparent",
    color: "#3D4F58",
    border: "1.5px solid #C7BFAE",
    borderRadius: 8,
    padding: "11px 16px",
    fontSize: 13.5,
    fontWeight: 600,
  },
  searchWrap: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: "#F4F1EA",
    border: "1.5px solid #C7BFAE",
    borderRadius: 8,
    padding: "9px 12px",
    marginBottom: 16,
  },
  searchInput: {
    border: "none",
    outline: "none",
    background: "transparent",
    flex: 1,
    fontSize: 13.5,
    color: "#1B2430",
    fontFamily: "'Inter', sans-serif",
  },
  clearSearchBtn: { background: "transparent", border: "none", color: "#7C8A93", display: "flex", padding: 2 },
  filterWrap: { display: "flex", alignItems: "center", gap: 8, marginBottom: 16, marginTop: -4 },
  selectWrap: { position: "relative", flex: 1, display: "flex", alignItems: "center" },
  select: {
    appearance: "none",
    WebkitAppearance: "none",
    width: "100%",
    background: "#F4F1EA",
    border: "1.5px solid #C7BFAE",
    borderRadius: 8,
    padding: "9px 34px 9px 12px",
    fontSize: 13.5,
    fontWeight: 600,
    color: "#1B2430",
    fontFamily: "'Inter', sans-serif",
    cursor: "pointer",
  },
  selectChevron: { position: "absolute", right: 11, pointerEvents: "none" },
  clearFilterBtn: {
    background: "transparent",
    border: "none",
    color: "#7C8A93",
    fontSize: 12.5,
    fontWeight: 600,
    padding: "4px 2px",
    flexShrink: 0,
  },
  tagRow: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 7 },
  customerTag: {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    fontSize: 11.5,
    fontWeight: 600,
    color: "#1B2430",
    background: "#E7E1D2",
    border: "1px solid #D8D1BF",
    borderRadius: 5,
    padding: "2px 7px",
  },
  detailTagRow: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 6 },
  detailCustomer: {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    fontSize: 12.5,
    fontWeight: 700,
    color: "#1B2430",
    background: "#E7E1D2",
    border: "1px solid #D8D1BF",
    borderRadius: 5,
    padding: "2px 8px",
  },
  errorBanner: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: "#FBEAE7",
    color: "#9A4137",
    border: "1px solid #E3B4AC",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 12.5,
    marginBottom: 14,
  },
  infoBanner: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    background: "#FBF1DD",
    color: "#8A6320",
    border: "1px solid #EAD5A6",
    borderRadius: 8,
    padding: "11px 13px",
    fontSize: 12.5,
    lineHeight: 1.45,
    marginBottom: 14,
  },
  emptyState: {
    textAlign: "center",
    padding: "56px 20px",
    color: "#7C8A93",
    fontSize: 13.5,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
  },
  cardList: { display: "flex", flexDirection: "column", gap: 10 },
  ticket: {
    display: "flex",
    width: "100%",
    textAlign: "left",
    background: "#F4F1EA",
    border: "1.5px solid #D8D1BF",
    borderRadius: 10,
    overflow: "hidden",
    padding: 0,
  },
  ticketStub: {
    width: 44,
    backgroundColor: "#1B2430",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  stampCircle: {
    transform: "rotate(-90deg)",
    color: "#FFB22C",
    fontFamily: "'Barlow Condensed', sans-serif",
    fontWeight: 700,
    fontSize: 13,
    letterSpacing: 2,
    border: "1.5px solid #FFB22C",
    borderRadius: 20,
    padding: "2px 8px",
    whiteSpace: "nowrap",
  },
  ticketBody: { padding: "12px 14px", flex: 1, minWidth: 0 },
  ticketTopRow: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 },
  ticketItem: { fontWeight: 700, fontSize: 14.5, color: "#1B2430", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  qtyBadge: {
    display: "inline-block",
    background: "#1B2430",
    color: "#FFB22C",
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 11,
    fontWeight: 500,
    borderRadius: 4,
    padding: "1px 5px",
    marginRight: 6,
  },
  moreItems: { fontSize: 11.5, color: "#8A8170", marginTop: 3, fontWeight: 500 },
  ticketDate: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 11,
    color: "#7C8A93",
    flexShrink: 0,
  },
  ticketMetaRow: { display: "flex", alignItems: "center", gap: 5, marginTop: 5, flexWrap: "wrap" },
  ticketMetaText: { fontSize: 12.5, color: "#4A5A62" },
  dot: { color: "#C7BFAE" },
  ticketFooter: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 9,
    borderTop: "1px dashed #D8D1BF",
    paddingTop: 8,
  },
  footerLeft: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 },
  loggedByText: { display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, color: "#A0ABB1" },
  qcPill: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    fontSize: 11,
    fontWeight: 600,
    color: "#8A6320",
    background: "#FBF1DD",
    border: "1px solid #EAD5A6",
    borderRadius: 20,
    padding: "2px 8px",
  },
  qcPillDone: { color: "#3E6B4A", background: "#E6F0E4", border: "1px solid #BED9BC" },
  checklistHead: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  removeChecklistBtn: {
    background: "transparent",
    border: "none",
    color: "#A0ABB1",
    fontSize: 11.5,
    fontWeight: 600,
    padding: 2,
  },
  checkList: { display: "flex", flexDirection: "column", gap: 2 },
  checkRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: "transparent",
    border: "none",
    padding: "8px 4px",
    textAlign: "left",
    borderBottom: "1px solid #EFEADC",
  },
  checkLabel: { fontSize: 13.5, lineHeight: 1.3 },
  viewLink: { display: "flex", alignItems: "center", gap: 2, fontSize: 12, fontWeight: 600, color: "#1B2430" },
  scanWrap: {
    position: "relative",
    borderRadius: 12,
    overflow: "hidden",
    background: "#1B2430",
    minHeight: 320,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  scanImage: { width: "100%", maxHeight: 420, objectFit: "contain", opacity: 0.5 },
  scanOverlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    color: "#F4F1EA",
  },
  scanLineWrap: {
    width: 48,
    height: 48,
    borderRadius: "50%",
    background: "rgba(255,178,44,0.12)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  scanText: { fontWeight: 600, fontSize: 14.5 },
  scanSubtext: { fontSize: 12, color: "#8FA3AC", marginTop: 4 },
  cancelScanBtn: {
    position: "absolute",
    top: 12,
    right: 12,
    display: "flex",
    alignItems: "center",
    gap: 5,
    background: "rgba(244,241,234,0.92)",
    border: "none",
    borderRadius: 7,
    padding: "7px 11px",
    fontSize: 12.5,
    fontWeight: 600,
    color: "#1B2430",
  },
  formImageWrap: { borderRadius: 10, overflow: "hidden", marginBottom: 14, border: "1.5px solid #D8D1BF", maxHeight: 200 },
  formImage: { width: "100%", maxHeight: 200, objectFit: "cover", display: "block" },
  woCard: {
    background: "#FBF1DD",
    border: "1.5px solid #EAD5A6",
    borderRadius: 10,
    padding: 14,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  woLabel: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11.5,
    fontWeight: 700,
    color: "#8A6320",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  woInput: {
    border: "1.5px solid #E0CFA0",
    borderRadius: 8,
    padding: "12px 13px",
    fontSize: 17,
    fontWeight: 600,
    color: "#1B2430",
    background: "#FFFFFF",
    fontFamily: "'IBM Plex Mono', monospace",
    letterSpacing: 0.5,
  },
  woTag: {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 12,
    fontWeight: 600,
    color: "#8A6320",
    background: "#FBF1DD",
    border: "1px solid #EAD5A6",
    borderRadius: 5,
    padding: "2px 7px",
  },
  detailWo: {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 12.5,
    fontWeight: 700,
    color: "#8A6320",
    background: "#FBF1DD",
    border: "1px solid #EAD5A6",
    borderRadius: 5,
    padding: "2px 8px",
    marginBottom: 6,
  },
  formCard: { background: "#F4F1EA", border: "1.5px solid #D8D1BF", borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 14 },
  fieldRow: { display: "flex", gap: 12 },
  fieldLabel: { display: "flex", flexDirection: "column", gap: 6, flex: 1 },
  fieldLabelRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11.5,
    fontWeight: 600,
    color: "#7C8A93",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  lineHeader: {
    display: "flex",
    gap: 8,
    fontSize: 10.5,
    fontWeight: 600,
    color: "#A0ABB1",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginTop: -6,
  },
  lineRow: { display: "flex", gap: 8, alignItems: "center" },
  qtyInput: {
    width: 56,
    flexShrink: 0,
    border: "1.5px solid #D8D1BF",
    borderRadius: 7,
    padding: "9px 8px",
    fontSize: 13.5,
    textAlign: "center",
    color: "#1B2430",
    background: "#FFFFFF",
    fontFamily: "'IBM Plex Mono', monospace",
  },
  lineDescInput: {
    flex: 1,
    minWidth: 0,
    border: "1.5px solid #D8D1BF",
    borderRadius: 7,
    padding: "9px 11px",
    fontSize: 13.5,
    color: "#1B2430",
    background: "#FFFFFF",
    fontFamily: "'Inter', sans-serif",
  },
  removeLineBtn: {
    flexShrink: 0,
    background: "transparent",
    border: "none",
    color: "#A0ABB1",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 4,
  },
  addLineBtn: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    alignSelf: "flex-start",
    background: "transparent",
    border: "1.5px dashed #C7BFAE",
    borderRadius: 7,
    padding: "7px 12px",
    fontSize: 12.5,
    fontWeight: 600,
    color: "#3D4F58",
  },
  input: {
    border: "1.5px solid #D8D1BF",
    borderRadius: 7,
    padding: "9px 11px",
    fontSize: 13.5,
    color: "#1B2430",
    background: "#FFFFFF",
    fontFamily: "'Inter', sans-serif",
  },
  formActions: { display: "flex", gap: 10, marginTop: 16, justifyContent: "flex-end" },
  modalBackdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(27,36,48,0.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 18,
    zIndex: 50,
  },
  modalCard: { background: "#F4F1EA", borderRadius: 12, padding: 20, maxWidth: 320, width: "100%" },
  detailCard: {
    background: "#F4F1EA",
    borderRadius: 14,
    width: "100%",
    maxWidth: 440,
    maxHeight: "88vh",
    overflowY: "auto",
    border: "1.5px solid #D8D1BF",
  },
  detailHeader: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "16px 16px 14px",
    borderBottom: "1px dashed #D8D1BF",
  },
  detailStamp: {
    color: "#FFB22C",
    background: "#1B2430",
    fontFamily: "'Barlow Condensed', sans-serif",
    fontWeight: 700,
    fontSize: 12,
    letterSpacing: 2,
    borderRadius: 6,
    padding: "6px 9px",
    flexShrink: 0,
  },
  detailTitle: { fontWeight: 700, fontSize: 15.5, color: "#1B2430", lineHeight: 1.25 },
  detailDate: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 11.5,
    color: "#7C8A93",
    marginTop: 3,
  },
  closeBtn: { background: "transparent", border: "none", color: "#7C8A93", display: "flex", padding: 4, flexShrink: 0 },
  detailBody: { padding: 16 },
  detailSectionLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: "#7C8A93",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  itemTable: { border: "1.5px solid #D8D1BF", borderRadius: 8, overflow: "hidden", background: "#FFFFFF" },
  itemRow: { display: "flex", gap: 10, padding: "9px 12px", borderBottom: "1px solid #EFEADC" },
  itemQty: {
    width: 36,
    flexShrink: 0,
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 13,
    fontWeight: 500,
    color: "#1B2430",
    textAlign: "right",
  },
  itemDesc: { fontSize: 13.5, color: "#1B2430", lineHeight: 1.35 },
  detailEmpty: { fontSize: 13, color: "#A0ABB1", fontStyle: "italic" },
  detailGrid: { display: "flex", flexWrap: "wrap", gap: 14, marginTop: 18 },
  detailField: { minWidth: 120, flex: 1 },
  detailFieldLabel: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    fontSize: 10.5,
    fontWeight: 600,
    color: "#7C8A93",
    textTransform: "uppercase",
    letterSpacing: 0.3,
    marginBottom: 4,
  },
  detailFieldValue: { fontSize: 13.5, color: "#1B2430", wordBreak: "break-word" },
  detailNotes: { marginTop: 18 },
  detailNotesText: { fontSize: 13, color: "#4A5A62", lineHeight: 1.5, background: "#EFEADC", borderRadius: 8, padding: "10px 12px" },
  detailActions: { display: "flex", gap: 10, padding: "0 16px 16px", justifyContent: "space-between" },
};
