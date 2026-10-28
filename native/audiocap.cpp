// audiocap.exe — captura de áudio por processo no Windows (Process Loopback, Win10 2004+ / Win11)
//
// Uso:
//   audiocap sessions                 -> JSON com processos que têm sessão de áudio
//   audiocap hwnd <hwnd>              -> JSON {pid,name} do processo dono da janela (raiz da árvore)
//   audiocap find <exe>               -> JSON com PIDs raiz de processos com esse nome (ex: Discord.exe)
//   audiocap capture include <pid>    -> PCM s16le 48kHz estéreo no stdout, só da árvore <pid>
//   audiocap capture exclude <pid>    -> PCM do sistema todo, exceto a árvore <pid>
//
// A captura encerra quando o stdin é fechado (processo pai saiu).

#define WIN32_LEAN_AND_MEAN
#define INITGUID
#include <windows.h>
#include <tlhelp32.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <io.h>
#include <fcntl.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <map>
#include <set>

// ---- Definições de Process Loopback (ausentes nos headers do MinGW) ----
typedef enum { ACT_DEFAULT = 0, ACT_PROCESS_LOOPBACK = 1 } ACT_TYPE;
typedef enum { PLM_INCLUDE_TREE = 0, PLM_EXCLUDE_TREE = 1 } PLM_MODE;
struct PL_PARAMS { DWORD TargetProcessId; PLM_MODE ProcessLoopbackMode; };
struct ACT_PARAMS { ACT_TYPE ActivationType; PL_PARAMS ProcessLoopbackParams; };
static const wchar_t* VAD_PROCESS_LOOPBACK = L"VAD\\Process_Loopback";

// {94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90}
static const GUID IID_IAgileObject_ = {0x94ea2b94, 0xe9cc, 0x49e0, {0xc0, 0xff, 0xee, 0x64, 0xca, 0x8f, 0x5b, 0x90}};

typedef HRESULT(WINAPI* PFN_ActivateAudioInterfaceAsync)(LPCWSTR, REFIID, PROPVARIANT*,
    IActivateAudioInterfaceCompletionHandler*, IActivateAudioInterfaceAsyncOperation**);

// ---- utilidades ----
static std::string utf8(const std::wstring& w) {
    if (w.empty()) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    std::string s(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
    return s;
}
static std::string jsonEsc(const std::string& s) {
    std::string o;
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') { o += '\\'; o += (char)c; }
        else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
        else o += (char)c;
    }
    return o;
}

struct ProcInfo { DWORD parent; std::wstring name; };
static std::map<DWORD, ProcInfo> snapshotProcs() {
    std::map<DWORD, ProcInfo> m;
    HANDLE h = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (h == INVALID_HANDLE_VALUE) return m;
    PROCESSENTRY32W pe; pe.dwSize = sizeof pe;
    if (Process32FirstW(h, &pe)) {
        do { m[pe.th32ProcessID] = {pe.th32ParentProcessID, pe.szExeFile}; } while (Process32NextW(h, &pe));
    }
    CloseHandle(h);
    return m;
}
// Sobe na árvore enquanto o pai tem o mesmo nome de executável (ex.: chrome.exe filho -> chrome.exe principal)
static DWORD rootOf(DWORD pid, const std::map<DWORD, ProcInfo>& m) {
    std::set<DWORD> seen;
    while (true) {
        auto it = m.find(pid);
        if (it == m.end()) return pid;
        auto pit = m.find(it->second.parent);
        if (pit == m.end() || seen.count(pid)) return pid;
        if (_wcsicmp(pit->second.name.c_str(), it->second.name.c_str()) != 0) return pid;
        seen.insert(pid);
        pid = it->second.parent;
    }
}
static std::wstring nameOf(DWORD pid, const std::map<DWORD, ProcInfo>& m) {
    auto it = m.find(pid);
    return it == m.end() ? L"" : it->second.name;
}

// ---- comando: sessions ----
static int cmdSessions() {
    auto procs = snapshotProcs();
    std::map<DWORD, bool> roots; // pid raiz -> tocando agora
    IMMDeviceEnumerator* en = nullptr;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en)))) {
        printf("[]\n"); return 1;
    }
    IMMDeviceCollection* col = nullptr;
    en->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &col);
    UINT nd = 0; if (col) col->GetCount(&nd);
    for (UINT d = 0; d < nd; d++) {
        IMMDevice* dev = nullptr; col->Item(d, &dev); if (!dev) continue;
        IAudioSessionManager2* mgr = nullptr;
        if (SUCCEEDED(dev->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&mgr))) {
            IAudioSessionEnumerator* se = nullptr;
            if (SUCCEEDED(mgr->GetSessionEnumerator(&se))) {
                int n = 0; se->GetCount(&n);
                for (int i = 0; i < n; i++) {
                    IAudioSessionControl* c = nullptr; se->GetSession(i, &c); if (!c) continue;
                    IAudioSessionControl2* c2 = nullptr;
                    if (SUCCEEDED(c->QueryInterface(IID_PPV_ARGS(&c2)))) {
                        DWORD pid = 0; c2->GetProcessId(&pid);
                        AudioSessionState st; c->GetState(&st);
                        if (pid && procs.count(pid)) {
                            DWORD r = rootOf(pid, procs);
                            roots[r] = roots[r] || st == AudioSessionStateActive;
                        }
                        c2->Release();
                    }
                    c->Release();
                }
                se->Release();
            }
            mgr->Release();
        }
        dev->Release();
    }
    if (col) col->Release();
    en->Release();
    std::string out = "[";
    bool first = true;
    for (auto& kv : roots) {
        if (!first) out += ",";
        first = false;
        out += "{\"pid\":" + std::to_string(kv.first) + ",\"name\":\"" + jsonEsc(utf8(nameOf(kv.first, procs))) +
               "\",\"active\":" + (kv.second ? "true" : "false") + "}";
    }
    out += "]\n";
    fwrite(out.data(), 1, out.size(), stdout);
    return 0;
}

static int cmdHwnd(const char* s) {
    HWND h = (HWND)(uintptr_t)_strtoui64(s, nullptr, 10);
    DWORD pid = 0;
    GetWindowThreadProcessId(h, &pid);
    if (!pid) { printf("{\"pid\":0}\n"); return 1; }
    auto procs = snapshotProcs();
    DWORD r = rootOf(pid, procs);
    printf("{\"pid\":%lu,\"name\":\"%s\"}\n", (unsigned long)r, jsonEsc(utf8(nameOf(r, procs))).c_str());
    return 0;
}

static int cmdFind(const char* exe) {
    auto procs = snapshotProcs();
    std::wstring w(exe, exe + strlen(exe));
    std::set<DWORD> roots;
    for (auto& kv : procs)
        if (_wcsicmp(kv.second.name.c_str(), w.c_str()) == 0) roots.insert(rootOf(kv.first, procs));
    std::string out = "[";
    bool first = true;
    for (DWORD r : roots) { if (!first) out += ","; first = false; out += std::to_string(r); }
    out += "]\n";
    fwrite(out.data(), 1, out.size(), stdout);
    return 0;
}

// ---- comando: capture ----
class CompletionHandler : public IActivateAudioInterfaceCompletionHandler {
    LONG ref = 1;
public:
    HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    HRESULT hr = E_FAIL;
    IAudioClient* client = nullptr;
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
        if (riid == IID_IUnknown || riid == __uuidof(IActivateAudioInterfaceCompletionHandler) || riid == IID_IAgileObject_) {
            *ppv = this; AddRef(); return S_OK;
        }
        *ppv = nullptr; return E_NOINTERFACE;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&ref); }
    STDMETHODIMP_(ULONG) Release() override { LONG r = InterlockedDecrement(&ref); if (!r) delete this; return r; }
    STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
        HRESULT hrAct = E_FAIL; IUnknown* unk = nullptr;
        hr = op->GetActivateResult(&hrAct, &unk);
        if (SUCCEEDED(hr)) hr = hrAct;
        if (SUCCEEDED(hr) && unk) hr = unk->QueryInterface(IID_PPV_ARGS(&client));
        if (unk) unk->Release();
        SetEvent(done);
        return S_OK;
    }
};

static volatile LONG g_stop = 0;
static DWORD WINAPI stdinWatcher(LPVOID) {
    char buf[64];
    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    DWORD n;
    while (ReadFile(in, buf, sizeof buf, &n, nullptr) && n > 0) {}
    InterlockedExchange(&g_stop, 1);
    return 0;
}

static int fail(const char* what, HRESULT hr) {
    fprintf(stderr, "ERRO %s hr=0x%08lx\n", what, (unsigned long)hr);
    return 2;
}

static int cmdCapture(const char* mode, DWORD pid) {
    _setmode(_fileno(stdout), _O_BINARY);
    HMODULE mm = LoadLibraryW(L"Mmdevapi.dll");
    auto activate = mm ? (PFN_ActivateAudioInterfaceAsync)GetProcAddress(mm, "ActivateAudioInterfaceAsync") : nullptr;
    if (!activate) return fail("ActivateAudioInterfaceAsync indisponivel", E_NOTIMPL);

    ACT_PARAMS p = {};
    p.ActivationType = ACT_PROCESS_LOOPBACK;
    p.ProcessLoopbackParams.TargetProcessId = pid;
    p.ProcessLoopbackParams.ProcessLoopbackMode = strcmp(mode, "exclude") == 0 ? PLM_EXCLUDE_TREE : PLM_INCLUDE_TREE;
    PROPVARIANT pv; PropVariantInit(&pv);
    pv.vt = VT_BLOB;
    pv.blob.cbSize = sizeof p;
    pv.blob.pBlobData = (BYTE*)&p;

    auto* h = new CompletionHandler();
    IActivateAudioInterfaceAsyncOperation* op = nullptr;
    HRESULT hr = activate(VAD_PROCESS_LOOPBACK, __uuidof(IAudioClient), &pv, h, &op);
    if (FAILED(hr)) return fail("activate", hr);
    WaitForSingleObject(h->done, 5000);
    if (FAILED(h->hr) || !h->client) return fail("activate result (requer Windows 10 2004+)", h->hr);
    IAudioClient* ac = h->client;

    WAVEFORMATEX fmt = {};
    fmt.wFormatTag = WAVE_FORMAT_PCM;
    fmt.nChannels = 2;
    fmt.nSamplesPerSec = 48000;
    fmt.wBitsPerSample = 16;
    fmt.nBlockAlign = fmt.nChannels * fmt.wBitsPerSample / 8;
    fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;

    hr = ac->Initialize(AUDCLNT_SHAREMODE_SHARED,
                        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                        200000, 0, &fmt, nullptr);
    if (FAILED(hr)) return fail("Initialize", hr);
    IAudioCaptureClient* cap = nullptr;
    hr = ac->GetService(IID_PPV_ARGS(&cap));
    if (FAILED(hr)) return fail("GetService", hr);
    HANDLE ev = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    ac->SetEventHandle(ev);
    hr = ac->Start();
    if (FAILED(hr)) return fail("Start", hr);
    fprintf(stderr, "OK capturando %s pid=%lu\n", mode, (unsigned long)pid);
    fflush(stderr);

    CreateThread(nullptr, 0, stdinWatcher, nullptr, 0, nullptr);
    std::vector<BYTE> zeros;
    while (!g_stop) {
        if (WaitForSingleObject(ev, 200) != WAIT_OBJECT_0) continue;
        UINT32 next = 0;
        while (SUCCEEDED(cap->GetNextPacketSize(&next)) && next > 0) {
            BYTE* data; UINT32 frames; DWORD flags;
            if (FAILED(cap->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
            size_t bytes = (size_t)frames * fmt.nBlockAlign;
            if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                if (zeros.size() < bytes) zeros.resize(bytes, 0);
                data = zeros.data();
            }
            if (fwrite(data, 1, bytes, stdout) != bytes) { g_stop = 1; }
            cap->ReleaseBuffer(frames);
        }
        fflush(stdout);
    }
    ac->Stop();
    return 0;
}

int main(int argc, char** argv) {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (argc >= 2 && !strcmp(argv[1], "sessions")) return cmdSessions();
    if (argc >= 3 && !strcmp(argv[1], "hwnd")) return cmdHwnd(argv[2]);
    if (argc >= 3 && !strcmp(argv[1], "find")) return cmdFind(argv[2]);
    if (argc >= 4 && !strcmp(argv[1], "capture")) return cmdCapture(argv[2], (DWORD)strtoul(argv[3], nullptr, 10));
    fprintf(stderr, "uso: audiocap sessions | hwnd <h> | find <exe> | capture include|exclude <pid>\n");
    return 1;
}
