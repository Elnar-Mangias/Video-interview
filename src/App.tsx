import { useCallback, useEffect, useRef, useState } from 'react';

type SignalMessage =
  | { type: 'hello'; id: string }
  | { type: 'offer'; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; sdp: RTCSessionDescriptionInit }
  | { type: 'ice-candidate'; candidate: RTCIceCandidateInit }
  | { type: 'hangup' };

const SIGNALING_URL = 'wss://inai-col3.fishrungames.com/signaling/';
const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function App() {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const ownIdRef = useRef(makeId());
  const peerIdRef = useRef<string | null>(null);
  const offerStartedRef = useRef(false);
  const mountedRef = useRef(true);

  const [status, setStatus] = useState('Не подключено');
  const [connected, setConnected] = useState(false);
  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [error, setError] = useState('');

  const sendSignal = useCallback((message: SignalMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }, []);

  const stopMedia = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
  }, []);

  const closePeer = useCallback(() => {
    peerRef.current?.close();
    peerRef.current = null;
    pendingCandidatesRef.current = [];
    offerStartedRef.current = false;
    peerIdRef.current = null;
  }, []);

  const endCall = useCallback((notify = true) => {
    if (notify) sendSignal({ type: 'hangup' });
    socketRef.current?.close();
    socketRef.current = null;
    closePeer();
    stopMedia();
    setConnected(false);
    setCameraOn(true);
    setMicOn(true);
    setStatus('Звонок завершён');
  }, [closePeer, sendSignal, stopMedia]);

  const createPeer = useCallback(() => {
    if (peerRef.current) return peerRef.current;

    const pc = new RTCPeerConnection(ICE_SERVERS);
    peerRef.current = pc;

    localStreamRef.current?.getTracks().forEach((track) => {
      pc.addTrack(track, localStreamRef.current!);
    });

    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (stream && remoteVideoRef.current) {
        remoteStreamRef.current = stream;
        remoteVideoRef.current.srcObject = stream;
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({
          type: 'ice-candidate',
          candidate: event.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (!mountedRef.current) return;
      if (pc.connectionState === 'connected') {
        setStatus('Собеседник подключён');
      } else if (pc.connectionState === 'connecting') {
        setStatus('Устанавливаем видеосвязь…');
      } else if (pc.connectionState === 'failed') {
        setStatus('Не удалось установить связь. Попробуйте подключиться снова.');
      } else if (pc.connectionState === 'disconnected') {
        setStatus('Связь прервана');
      }
    };

    return pc;
  }, [sendSignal]);

  const flushCandidates = useCallback(async (pc: RTCPeerConnection) => {
    const queued = pendingCandidatesRef.current.splice(0);
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        console.warn('Не удалось добавить ICE candidate', err);
      }
    }
  }, []);

  const handleSignal = useCallback(async (raw: string) => {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      setError('Сервер прислал сообщение в неизвестном формате.');
      return;
    }

    try {
      if (message.type === 'peer-left') {
        closePeer();
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
        setStatus('Собеседник отключился');
        return;
      }

      if (message.type === 'hello' && typeof message.id === 'string') {
        peerIdRef.current = message.id;
        // Оба клиента обмениваются hello. Клиент с меньшим ID создаёт offer,
        // чтобы offer не создавался одновременно с обеих сторон.
        if (ownIdRef.current < message.id && !offerStartedRef.current) {
          offerStartedRef.current = true;
          const pc = createPeer();
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sendSignal({ type: 'offer', sdp: pc.localDescription! });
          setStatus('Отправлено приглашение. Ожидаем ответ…');
        }
        return;
      }

      if (message.type === 'offer' && message.sdp) {
        const pc = createPeer();
        await pc.setRemoteDescription(message.sdp);
        await flushCandidates(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal({ type: 'answer', sdp: pc.localDescription! });
        setStatus('Ответ отправлен. Устанавливаем связь…');
        return;
      }

      if (message.type === 'answer' && message.sdp) {
        const pc = peerRef.current;
        if (!pc) return;
        await pc.setRemoteDescription(message.sdp);
        await flushCandidates(pc);
        setStatus('Ответ получен. Устанавливаем связь…');
        return;
      }

      if (message.type === 'ice-candidate' && message.candidate) {
        const pc = peerRef.current;
        if (!pc || !pc.remoteDescription) {
          pendingCandidatesRef.current.push(message.candidate);
        } else {
          await pc.addIceCandidate(message.candidate);
        }
        return;
      }

      if (message.type === 'hangup') {
        closePeer();
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
        setStatus('Собеседник завершил звонок');
      }
    } catch (err) {
      console.error(err);
      setError('Ошибка при установлении видеосвязи. Проверьте соединение и попробуйте снова.');
    }
  }, [closePeer, createPeer, flushCandidates, sendSignal]);

  const startCall = async () => {
    setError('');
    setStatus('Запрашиваем доступ к камере и микрофону…');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      const socket = new WebSocket(SIGNALING_URL);
      socketRef.current = socket;

      socket.onopen = () => {
        setConnected(true);
        setStatus('Ожидаем второго участника…');
        socket.send(JSON.stringify({ type: 'hello', id: ownIdRef.current }));
      };

      socket.onmessage = (event) => {
        void handleSignal(String(event.data));
      };

      socket.onerror = () => {
        setError('Не удалось подключиться к signaling-серверу.');
      };

      socket.onclose = () => {
        if (socketRef.current === socket) {
          socketRef.current = null;
          closePeer();
          stopMedia();
          setConnected(false);
          setStatus('Соединение с сервером закрыто');
        }
      };
    } catch (err) {
      console.error(err);
      stopMedia();
      setStatus('Не удалось начать звонок');
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setError('Разрешите доступ к камере и микрофону в настройках браузера.');
      } else if (err instanceof DOMException && err.name === 'NotFoundError') {
        setError('Камера или микрофон не найдены.');
      } else {
        setError('Не удалось получить камеру/микрофон или подключиться к серверу.');
      }
    }
  };

  const toggleCamera = () => {
    const next = !cameraOn;
    localStreamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = next;
    });
    setCameraOn(next);
  };

  const toggleMic = () => {
    const next = !micOn;
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = next;
    });
    setMicOn(next);
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      socketRef.current?.close();
      peerRef.current?.close();
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="./" aria-label="Video Interview home">
          <span className="brand-mark">V</span>
          <span>VIDEO<span className="brand-light">INTERVIEW</span></span>
        </a>
        <div className="top-status">
          <span className={`status-dot ${connected ? 'active' : ''}`} />
          {status}
        </div>
      </header>

      <section className="intro">
        <p className="eyebrow">ONE-TO-ONE MEETING</p>
        <h1>Видеособеседование</h1>
        <p className="subtitle">Приватная видеовстреча один на один</p>
      </section>

      <section className="video-grid" aria-label="Окна видеозвонка">
        <article className="video-card local-card">
          <video ref={localVideoRef} autoPlay playsInline muted />
          {!localStreamRef.current && (
            <div className="video-placeholder">
              <span className="avatar">Я</span>
              <span>Ваше видео появится здесь</span>
            </div>
          )}
          <div className="video-label"><span className="tiny-dot" /> Вы</div>
          <span className="video-tag">LOCAL</span>
        </article>

        <article className="video-card remote-card">
          <video ref={remoteVideoRef} autoPlay playsInline />
          <div className="video-placeholder remote-placeholder">
            <span className="avatar remote-avatar">?</span>
            <span>Ожидаем собеседника</span>
          </div>
          <div className="video-label"><span className="tiny-dot" /> Собеседник</div>
          <span className="video-tag">REMOTE</span>
        </article>
      </section>

      {error && <div className="error-banner" role="alert">{error}</div>}

      <section className="controls">
        {!connected ? (
          <button className="primary-button" onClick={startCall}>
            <span aria-hidden="true">↗</span> Подключиться к собеседованию
          </button>
        ) : (
          <>
            <button className={`control-button ${!micOn ? 'disabled' : ''}`} onClick={toggleMic}>
              <span>{micOn ? '🎙' : '🔇'}</span>
              {micOn ? 'Микрофон' : 'Микрофон выключен'}
            </button>
            <button className={`control-button ${!cameraOn ? 'disabled' : ''}`} onClick={toggleCamera}>
              <span>{cameraOn ? '▣' : '⊘'}</span>
              {cameraOn ? 'Камера' : 'Камера выключена'}
            </button>
            <button className="hangup-button" onClick={() => endCall(true)}>
              <span>×</span> Завершить звонок
            </button>
          </>
        )}
      </section>

      <footer className="footer">
        <span>VIDEO INTERVIEW</span>
        <span>WebRTC · Peer-to-peer</span>
      </footer>
    </main>
  );
}
