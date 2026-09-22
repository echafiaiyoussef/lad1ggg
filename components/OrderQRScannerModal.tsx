import React, { useEffect, useRef, useState, useCallback } from 'react';
import jsQR from 'jsqr';
import { 
  MultiFormatReader, 
  RGBLuminanceSource, 
  BinaryBitmap, 
  HybridBinarizer 
} from '@zxing/library';
import { 
  Camera, 
  X, 
  CheckCircle2, 
  AlertCircle, 
  RefreshCw, 
  Smartphone, 
  QrCode,
  ScanQrCode,
  ScanBarcode, 
  Scan,
  Barcode,
  Send, 
  Volume2, 
  VolumeX, 
  Flashlight,
  ExternalLink,
  RotateCw,
  Search,
  Check,
  MessageSquare,
  ZoomIn,
  ZoomOut,
  Sparkles
} from 'lucide-react';
import { Order, OrderStatus } from '../types';
import { supabase } from '../supabase';
import { normalizeArabicDigits } from '../services/hardwareBarcodeScanner';

interface OrderQRScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  orders: Order[];
  onOrderUpdated: (orderId: string, newStatus: OrderStatus, options?: { skipNotification?: boolean }) => Promise<void> | void;
  laundryName: string;
  onSendWhatsAppNotification?: (order: Order) => Promise<{ success: boolean; error?: string }>;
  isWhatsAppConnected?: boolean;
}

export const OrderQRScannerModal: React.FC<OrderQRScannerModalProps> = ({
  isOpen,
  onClose,
  orders,
  onOrderUpdated,
  laundryName,
  onSendWhatsAppNotification,
  isWhatsAppConnected = false
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number | null>(null);

  // Synchronous execution refs to prevent concurrent frame triggers
  const isProcessingRef = useRef<boolean>(false);
  const isScanningRef = useRef<boolean>(true);
  const lastScannedRef = useRef<{ code: string; timestamp: number } | null>(null);
  const zxingReaderRef = useRef<MultiFormatReader | null>(null);
  const barcodeDetectorRef = useRef<any>(null);
  const isFrameDecodingRef = useRef<boolean>(false);
  const lastScanTimeRef = useRef<number>(0);

  // Touch pinch-to-zoom tracking
  const touchDistanceRef = useRef<number | null>(null);
  const touchZoomStartRef = useRef<number>(1);

  const [hasCamera, setHasCamera] = useState<boolean>(true);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [isScanning, setIsScanning] = useState<boolean>(true);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [manualInput, setManualInput] = useState<string>('');

  // Zoom & Torch States
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [zoomCapabilities, setZoomCapabilities] = useState<{ min: number; max: number; step: number; supported: boolean }>({
    min: 1,
    max: 3,
    step: 0.1,
    supported: false
  });
  const [torchSupported, setTorchSupported] = useState<boolean>(false);
  const [torchOn, setTorchOn] = useState<boolean>(false);
  const [scanSuccessPulse, setScanSuccessPulse] = useState<boolean>(false);

  // Initialize ZXing MultiFormatReader
  if (!zxingReaderRef.current) {
    try {
      zxingReaderRef.current = new MultiFormatReader();
    } catch (e) {
      console.warn("Failed to initialize ZXing MultiFormatReader:", e);
    }
  }

  // Result state
  const [processedOrder, setProcessedOrder] = useState<Order | null>(null);
  const [notificationStatus, setNotificationStatus] = useState<{
    sent: boolean;
    channel: 'silent_bot' | 'whatsapp_link' | 'none' | 'auto_whatsapp' | 'failed';
    message: string;
    waUrl?: string;
  } | null>(null);

  // Play beep sound using Web Audio API
  const playBeep = useCallback(() => {
    if (!soundEnabled) return;
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;
      const ctx = new AudioContextClass();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.14);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.15);
    } catch (e) {
      console.warn("AudioContext beep failed:", e);
    }
  }, [soundEnabled]);

  // Stop camera stream
  const stopCamera = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => {
        try { track.stop(); } catch (e) {}
      });
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  // Start camera stream with autofocus and zoom capabilities detection
  const startCamera = useCallback(async (mode: 'environment' | 'user' = facingMode) => {
    stopCamera();
    setCameraError(null);
    setIsScanning(true);
    setScanSuccessPulse(false);

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("المتصفح لا يدعم الوصول المباشر لكاميرا الجهاز أو يتطلب اتصالاً آمناً (HTTPS).");
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: mode },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            // Continuous autofocus on supported devices
            advanced: [{ focusMode: 'continuous' } as any]
          },
          audio: false
        });
      } catch (err1) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: mode },
              width: { ideal: 1280 },
              height: { ideal: 720 }
            },
            audio: false
          });
        } catch (err2) {
          // Fallback to basic video without specific facingMode constraints
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false
          });
        }
      }

      streamRef.current = stream;

      // Inspect camera capabilities (autofocus, hardware zoom, torch)
      const track = stream.getVideoTracks()[0];
      if (track) {
        try {
          const caps = (track.getCapabilities ? track.getCapabilities() : {}) as any;
          
          // 1. Continuous autofocus
          if (caps.focusMode && Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
            try {
              await track.applyConstraints({
                advanced: [{ focusMode: 'continuous' } as any]
              });
            } catch (focusErr) {}
          }

          // 2. Hardware zoom detection
          if (caps.zoom) {
            const minZ = caps.zoom.min || 1;
            const maxZ = Math.min(caps.zoom.max || 5, 4);
            const stepZ = caps.zoom.step || 0.1;
            setZoomCapabilities({
              min: minZ,
              max: maxZ,
              step: stepZ,
              supported: true
            });
          } else {
            // Software/digital zoom fallback (1x to 3x)
            setZoomCapabilities({
              min: 1,
              max: 3,
              step: 0.1,
              supported: false
            });
          }

          // 3. Torch detection
          if (caps.torch) {
            setTorchSupported(true);
          } else {
            setTorchSupported(false);
          }
        } catch (capsErr) {
          console.warn("Could not inspect camera track capabilities:", capsErr);
        }
      }

      if (videoRef.current) {
        const vid = videoRef.current;
        vid.srcObject = stream;
        vid.setAttribute('playsinline', 'true');
        vid.setAttribute('webkit-playsinline', 'true');
        vid.muted = true;
        vid.onloadedmetadata = () => {
          vid.play().catch(playErr => {
            console.warn("video.play() inside onloadedmetadata failed:", playErr);
          });
        };
        try {
          await vid.play();
        } catch (playErr) {
          console.warn("video.play() immediate call failed (waiting for user interaction or metadata):", playErr);
        }
      }
      setHasCamera(true);
    } catch (err: any) {
      console.warn("Camera start error:", err);
      setHasCamera(false);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setCameraError("تم رفض إذن الكاميرا. يرجى السماح بالوصول للكاميرا من إعدادات المتصفح أو إدخال رقم الفاتورة يدوياً.");
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        setCameraError("لم يتم العثور على كاميرا متصلة بالجهاز. يمكنك كتابة رقم الفاتورة بالأسفل.");
      } else {
        setCameraError(err.message || "تعذر تشغيل الكاميرا حالياً.");
      }
    }
  }, [facingMode, stopCamera]);

  // Apply zoom level (hardware if supported, otherwise digital scale)
  const applyZoom = useCallback(async (level: number) => {
    const minZ = zoomCapabilities.min || 1;
    const maxZ = zoomCapabilities.max || 3;
    const clamped = Math.max(minZ, Math.min(maxZ, Math.round(level * 10) / 10));
    setZoomLevel(clamped);

    const track = streamRef.current?.getVideoTracks()[0];
    if (track && zoomCapabilities.supported) {
      try {
        await track.applyConstraints({
          advanced: [{ zoom: clamped }] as any
        });
      } catch (e) {
        console.warn("Hardware zoom application failed, using digital zoom fallback:", e);
      }
    }
  }, [zoomCapabilities]);

  // Toggle camera flashlight (torch)
  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || !torchSupported) return;
    try {
      const nextTorch = !torchOn;
      await track.applyConstraints({
        advanced: [{ torch: nextTorch }] as any
      });
      setTorchOn(nextTorch);
    } catch (e) {
      console.warn("Torch toggle failed:", e);
    }
  }, [torchOn, torchSupported]);

  // Touch gesture pinch-to-zoom handlers
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      touchDistanceRef.current = Math.hypot(dx, dy);
      touchZoomStartRef.current = zoomLevel;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && touchDistanceRef.current) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const currentDistance = Math.hypot(dx, dy);
      const factor = currentDistance / touchDistanceRef.current;
      applyZoom(touchZoomStartRef.current * factor);
    }
  };

  const handleTouchEnd = () => {
    touchDistanceRef.current = null;
  };

  // Tap camera view to trigger autofocus
  const handleTapToFocus = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      const caps = (track.getCapabilities ? track.getCapabilities() : {}) as any;
      if (caps.focusMode && Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
        await track.applyConstraints({
          advanced: [{ focusMode: 'continuous' } as any]
        });
      }
    } catch (err) {}
  };

  // Extract order from scanned QR text
  const matchOrder = useCallback(async (scannedText: string): Promise<Order | null> => {
    const raw = normalizeArabicDigits(scannedText || '').trim();
    if (!raw) return null;

    // Cleaned version without leading hash or spaces
    const cleanRaw = raw.replace(/^#+/, '').trim();

    // 0. URL matching (if QR contains a full order URL)
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      try {
        const url = new URL(raw);
        const orderParam = url.searchParams.get('order') || 
                           url.searchParams.get('order_number') || 
                           url.searchParams.get('id') || 
                           url.searchParams.get('invoice');
        if (orderParam) {
          const cleanParam = normalizeArabicDigits(orderParam).replace(/^#+/, '').trim();
          const match = orders.find(o => 
            o.order_number === cleanParam || 
            o.id === cleanParam || 
            (o.order_number && o.order_number.toLowerCase() === cleanParam.toLowerCase())
          );
          if (match) return match;
        }
        const segments = url.pathname.split('/').filter(Boolean);
        if (segments.length > 0) {
          const lastSegment = normalizeArabicDigits(segments[segments.length - 1]).replace(/^#+/, '').trim();
          const match = orders.find(o => 
            o.order_number === lastSegment || 
            o.id === lastSegment ||
            (o.order_number && o.order_number.toLowerCase() === lastSegment.toLowerCase())
          );
          if (match) return match;
        }
      } catch (urlErr) {}
    }

    // 1. Direct match with order_number or id (case-insensitive)
    let target = orders.find(o => 
      o.order_number === raw || 
      o.order_number === cleanRaw ||
      o.id === raw ||
      o.id === cleanRaw ||
      (o.order_number && o.order_number.toLowerCase() === raw.toLowerCase()) ||
      (o.order_number && o.order_number.toLowerCase() === cleanRaw.toLowerCase())
    );
    if (target) return target;

    // 2. Extract number from pattern like #1234 or رقم الفاتورة: #1234 or رقم الفاتورة: 1234 or ORD-1234
    const invoiceNumMatch = raw.match(/(?:رقم الفاتورة|الطلب|فاتورة|Invoice|Order|ORD|معرف الطلب)[^\d#]*#?\s*([a-zA-Z0-9_\u0660-\u0669-]+)/i) ||
                            raw.match(/#\s*([a-zA-Z0-9_\u0660-\u0669-]+)/);
    
    if (invoiceNumMatch && invoiceNumMatch[1]) {
      const extractedNumber = invoiceNumMatch[1].trim();
      const cleanExtracted = extractedNumber.replace(/^#+/, '').trim();
      target = orders.find(o => 
        o.order_number === extractedNumber || 
        o.order_number === cleanExtracted ||
        o.id === extractedNumber ||
        o.id === cleanExtracted ||
        (o.order_number && o.order_number.endsWith(cleanExtracted))
      );
      if (target) return target;
    }

    // 3. Match UUID pattern
    const uuidMatch = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuidMatch) {
      target = orders.find(o => o.id === uuidMatch[0]);
      if (target) return target;
    }

    // 4. Match if any order's order_number exists as a distinct token or substring
    for (const ord of orders) {
      if (ord.order_number && ord.order_number.length >= 2 && (raw.includes(ord.order_number) || cleanRaw.includes(ord.order_number))) {
        return ord;
      }
    }

    // 5. Check if scanned text has lines (like formatted invoice QR) and inspect line by line
    const lines = raw.split(/[\r\n]+/);
    for (const line of lines) {
      const cleanedLine = line.trim();
      if (!cleanedLine) continue;
      const lineNumMatch = cleanedLine.match(/#?\s*([a-zA-Z0-9_-]{2,})/);
      if (lineNumMatch && lineNumMatch[1]) {
        const potentialNum = lineNumMatch[1].replace(/^#+/, '').trim();
        const lineTarget = orders.find(o => o.order_number === potentialNum || o.id === potentialNum);
        if (lineTarget) return lineTarget;
      }
    }

    // 6. Fallback Supabase query if not found in current loaded orders
    try {
      const searchKey = invoiceNumMatch ? invoiceNumMatch[1].replace(/^#+/, '').trim() : cleanRaw;
      const { data } = await supabase
        .from('orders')
        .select('*')
        .or(`order_number.eq.${searchKey},id.eq.${searchKey},order_number.eq.${raw}`)
        .limit(1);
      if (data && data.length > 0) {
        return data[0] as Order;
      }
    } catch (e) {
      console.warn("Supabase lookup for scanned order failed:", e);
    }

    return null;
  }, [orders]);

  // Handle scanned code
  const handleCodeFound = useCallback(async (code: string) => {
    const raw = (code || '').trim();
    if (!raw) return;

    // Check ref-based lock immediately to prevent race conditions across frames
    if (isProcessingRef.current) return;

    // Check duplicate code cooldown (within 4 seconds)
    const now = Date.now();
    if (lastScannedRef.current && lastScannedRef.current.code === raw && (now - lastScannedRef.current.timestamp < 4000)) {
      return;
    }

    // Immediately acquire lock and pause scanning
    isProcessingRef.current = true;
    isScanningRef.current = false;
    lastScannedRef.current = { code: raw, timestamp: now };

    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    setIsProcessing(true);
    setIsScanning(false);
    playBeep();
    if (navigator.vibrate) {
      try { navigator.vibrate([100, 50, 100]); } catch (e) {}
    }

    try {
      const order = await matchOrder(raw);
      if (!order) {
        setCameraError(`لم يتم العثور على طلب مطابق للرمز الممسوح:\n"${raw.length > 60 ? raw.slice(0, 60) + '...' : raw}"`);
        setIsProcessing(false);
        isProcessingRef.current = false;
        // Resume scanning after 1.5 seconds so user can point at correct code
        setTimeout(() => {
          if (!isProcessingRef.current) {
            isScanningRef.current = true;
            setIsScanning(true);
          }
        }, 1500);
        return;
      }

      // Update Order Status to 'Ready' (جاهز للاستلام) with skipNotification: true
      // OrderQRScannerModal handles its own single notification below
      await onOrderUpdated(order.id, 'Ready', { skipNotification: true });
      const updatedOrder: Order = { ...order, status: 'Ready' };
      setProcessedOrder(updatedOrder);

      // Construct ready notification message
      const smartMessage = `مرحباً ${order.customer_name}، يسعدنا إبلاغك بأن طلبك رقم #${order.order_number} في ${laundryName || 'مغسلة عود ونظافة'} قد تم الانتهاء منه بالكامل وهو جاهز للاستلام الآن! 🧺✨\n\n📦 رقم الفاتورة: #${order.order_number}\n💰 المبلغ الإجمالي: ${order.total.toFixed(2)} ر.س\n📍 حالة السداد: ${order.is_paid ? 'مسددة بالكامل ✅' : 'المبلغ مستحق عند الاستلام ⏳'}\n\nنرجو التفضل بزيارتنا لاستلامه. نسعد دائماً بخدمتكم! 🌟`;

      const cleanPhone = (order.customer_phone || '').replace(/\D/g, '');
      let finalPhone = cleanPhone;
      if (finalPhone.startsWith('00')) finalPhone = finalPhone.slice(2);
      if (finalPhone.startsWith('05') && finalPhone.length === 10) {
        finalPhone = '966' + finalPhone.slice(1);
      } else if (finalPhone.startsWith('5') && finalPhone.length === 9) {
        finalPhone = '966' + finalPhone;
      } else if ((finalPhone.startsWith('06') || finalPhone.startsWith('07')) && finalPhone.length === 10) {
        finalPhone = '212' + finalPhone.slice(1);
      } else if (finalPhone.startsWith('0')) {
        finalPhone = '966' + finalPhone.slice(1);
      }
      finalPhone = finalPhone.replace(/^0+/, '');
      const waUrl = `https://wa.me/${finalPhone}?text=${encodeURIComponent(smartMessage)}`;

      // Send single notification automatically via WhatsApp Bot / Twilio
      let notifiedViaBot = false;
      let botErrorMsg = '';
      if (onSendWhatsAppNotification) {
        try {
          const res = await onSendWhatsAppNotification(updatedOrder);
          if (res && res.success) {
            notifiedViaBot = true;
          } else if (res && res.error) {
            botErrorMsg = res.error;
          }
        } catch (botErr: any) {
          console.warn("Automated notification callback error:", botErr);
          botErrorMsg = botErr?.message || '';
        }
      }

      if (notifiedViaBot) {
        setNotificationStatus({
          sent: true,
          channel: 'silent_bot',
          message: 'تم إرسال إشعار الجاهزية للعميل تلقائياً في الخلفية مع الفاتورة الرسمية! 📲',
          waUrl
        });
      } else {
        setNotificationStatus({
          sent: false,
          channel: 'failed',
          message: botErrorMsg ? `تنبيه الإشعار: ${botErrorMsg}` : 'بوت الواتساب غير متصل حالياً لإرسال الرسالة التلقائية.',
          waUrl
        });
      }
    } catch (err: any) {
      console.error("Order QR processing error:", err);
      setCameraError(err.message || "حدث خطأ أثناء معالجة الطلب.");
      isProcessingRef.current = false;
      isScanningRef.current = true;
      setIsScanning(true);
    } finally {
      setIsProcessing(false);
    }
  }, [matchOrder, onOrderUpdated, onSendWhatsAppNotification, laundryName, playBeep]);

  // Keep a stable ref to handleCodeFound to avoid tearing down the scan loop unnecessarily
  const handleCodeFoundRef = useRef(handleCodeFound);
  handleCodeFoundRef.current = handleCodeFound;

  // Multi-tier Video scanning frame loop (BarcodeDetector + jsQR + ZXing MultiFormat)
  useEffect(() => {
    if (!isOpen || !isScanning || processedOrder) return;

    let isSubscribed = true;

    const scanFrame = async () => {
      if (!isSubscribed || !isScanningRef.current || isProcessingRef.current) return;

      const now = performance.now();
      // Throttle scanning to every 40ms (~25 fps) to avoid main-thread saturation and frame jitter
      if (now - lastScanTimeRef.current < 40) {
        if (isSubscribed && isScanningRef.current && !isProcessingRef.current) {
          animFrameRef.current = requestAnimationFrame(scanFrame);
        }
        return;
      }
      lastScanTimeRef.current = now;

      const video = videoRef.current;
      const canvas = canvasRef.current;

      // Check if video is loaded and rendering frames (readyState >= 2 indicates current data available)
      if (video && canvas && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && !isFrameDecodingRef.current) {
        isFrameDecodingRef.current = true;

        try {
          let detectedCode: string | null = null;

          // 1. Tier 1: Hardware-Accelerated Native BarcodeDetector (Supported on Android Chrome & modern browsers)
          if (typeof (window as any).BarcodeDetector !== 'undefined') {
            try {
              if (!barcodeDetectorRef.current) {
                barcodeDetectorRef.current = new (window as any).BarcodeDetector({
                  formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'data_matrix']
                });
              }
              const detectedList = await barcodeDetectorRef.current.detect(video);
              if (detectedList && detectedList.length > 0 && detectedList[0].rawValue) {
                detectedCode = detectedList[0].rawValue.trim();
              }
            } catch (detectorErr) {
              // Graceful fallback to canvas decoding
            }
          }

          // 2. Tier 2: Canvas-based scanning (jsQR + ZXing MultiFormatReader)
          if (!detectedCode) {
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              // Rescale to a reliable scanning dimension (around 640px width) for ultra-fast processing
              const targetWidth = Math.min(640, video.videoWidth);
              const targetHeight = Math.round((targetWidth / video.videoWidth) * video.videoHeight);
              canvas.width = targetWidth;
              canvas.height = targetHeight;

              // If digital zoom is applied without hardware zoom, crop into center so codes are large
              if (!zoomCapabilities.supported && zoomLevel > 1) {
                const cropW = video.videoWidth / zoomLevel;
                const cropH = video.videoHeight / zoomLevel;
                const cropX = (video.videoWidth - cropW) / 2;
                const cropY = (video.videoHeight - cropH) / 2;
                ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, targetWidth, targetHeight);
              } else {
                ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
              }

              // A. jsQR on full frame
              const fullImageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
              const fullQr = jsQR(fullImageData.data, targetWidth, targetHeight, {
                inversionAttempts: 'attemptBoth'
              });
              if (fullQr && fullQr.data && fullQr.data.trim()) {
                detectedCode = fullQr.data.trim();
              }

              // B. jsQR on Center Reticle Crop (where user centers the paper/tag)
              if (!detectedCode) {
                const centerSize = Math.floor(Math.min(targetWidth, targetHeight) * 0.7);
                const startX = Math.floor((targetWidth - centerSize) / 2);
                const startY = Math.floor((targetHeight - centerSize) / 2);
                if (centerSize > 50) {
                  const centerImageData = ctx.getImageData(startX, startY, centerSize, centerSize);
                  const centerQr = jsQR(centerImageData.data, centerSize, centerSize, {
                    inversionAttempts: 'attemptBoth'
                  });
                  if (centerQr && centerQr.data && centerQr.data.trim()) {
                    detectedCode = centerQr.data.trim();
                  }
                }
              }

              // C. ZXing MultiFormatReader for 1D Barcodes (CODE128 from tags, Code39, EAN)
              if (!detectedCode && zxingReaderRef.current) {
                try {
                  const luminanceSource = new RGBLuminanceSource(
                    new Uint8ClampedArray(fullImageData.data),
                    targetWidth,
                    targetHeight
                  );
                  const binaryBitmap = new BinaryBitmap(new HybridBinarizer(luminanceSource));
                  const zxResult = zxingReaderRef.current.decode(binaryBitmap);
                  if (zxResult && zxResult.getText()) {
                    detectedCode = zxResult.getText().trim();
                  }
                } catch (zxErr) {
                  // Barcode not found in this frame
                }
              }
            }
          }

          // If a code was found, trigger success feedback and pass to handler
          if (detectedCode && detectedCode.trim()) {
            if (!isProcessingRef.current) {
              setScanSuccessPulse(true);
              isProcessingRef.current = true;
              isScanningRef.current = false;
              if (animFrameRef.current) {
                cancelAnimationFrame(animFrameRef.current);
                animFrameRef.current = null;
              }
              handleCodeFoundRef.current(detectedCode);
              return;
            }
          }
        } catch (scanErr) {
          // Ignored - frame decode transient error
        } finally {
          isFrameDecodingRef.current = false;
        }
      }

      if (isSubscribed && isScanningRef.current && !isProcessingRef.current) {
        animFrameRef.current = requestAnimationFrame(scanFrame);
      }
    };

    animFrameRef.current = requestAnimationFrame(scanFrame);

    return () => {
      isSubscribed = false;
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
    };
  }, [isOpen, isScanning, !!processedOrder, zoomLevel, zoomCapabilities.supported]);

  // Handle open/close lifecycle
  useEffect(() => {
    if (isOpen) {
      isProcessingRef.current = false;
      isScanningRef.current = true;
      lastScannedRef.current = null;
      setProcessedOrder(null);
      setNotificationStatus(null);
      setCameraError(null);
      setManualInput('');
      setIsScanning(true);
      setIsProcessing(false);
      startCamera();
    } else {
      isProcessingRef.current = false;
      isScanningRef.current = false;
      stopCamera();
    }
    return () => {
      isProcessingRef.current = false;
      isScanningRef.current = false;
      stopCamera();
    };
  }, [isOpen, startCamera, stopCamera]);

  // Listen for global hardware barcode/QR scanner events
  useEffect(() => {
    if (!isOpen) return;

    const onHardwareScanEvent = (e: any) => {
      if (e.detail?.order) {
        setProcessedOrder(e.detail.order);
        setNotificationStatus({
          sent: true,
          channel: 'silent_bot',
          message: 'تم مسح الرمز وتجهيز الطلب وإرسال رسالة الواتساب تلقائياً! 📲'
        });
        setIsScanning(false);
        setIsProcessing(false);
      } else if (e.detail?.code) {
        handleCodeFound(e.detail.code);
      }
    };

    window.addEventListener('hardware-qr-scanned', onHardwareScanEvent);
    return () => {
      window.removeEventListener('hardware-qr-scanned', onHardwareScanEvent);
    };
  }, [isOpen, handleCodeFound]);

  // Switch between front and rear camera
  const toggleFacingMode = () => {
    const nextMode = facingMode === 'environment' ? 'user' : 'environment';
    setFacingMode(nextMode);
    startCamera(nextMode);
  };

  // Reset scanner to scan another order
  const handleScanAnother = () => {
    isProcessingRef.current = false;
    isScanningRef.current = true;
    lastScannedRef.current = null;
    setProcessedOrder(null);
    setNotificationStatus(null);
    setCameraError(null);
    setManualInput('');
    setScanSuccessPulse(false);
    setIsScanning(true);
    setIsProcessing(false);
    startCamera();
  };

  // Manual code submission
  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualInput.trim()) return;
    handleCodeFound(manualInput.trim());
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-3 md:p-6 overflow-y-auto animate-in fade-in duration-200" dir="rtl">
      <div className="bg-white rounded-[2.5rem] shadow-2xl border border-slate-100 w-full max-w-lg overflow-hidden my-4 relative">
        {/* Header */}
        <div className="bg-gradient-to-r from-indigo-700 via-indigo-800 to-violet-800 p-6 text-white flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-white/10 backdrop-blur-md flex items-center justify-center border border-white/20 shadow-inner">
              <div className="relative w-6 h-6 flex items-center justify-center text-white">
                <Scan size={24} strokeWidth={2.2} />
                <Barcode size={15} strokeWidth={2.4} className="absolute inset-0 m-auto" />
              </div>
            </div>
            <div>
              <h3 className="text-lg font-black tracking-tight">مسح QR / باركود الفاتورة</h3>
              <p className="text-indigo-200 text-xs mt-0.5 font-bold">
                تحديث الطلب تلقائياً إلى (جاهز للاستلام) وإشعار العميل
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-10 h-10 rounded-2xl bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-all cursor-pointer"
            aria-label="إغلاق"
          >
            <X size={20} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 md:p-8 space-y-6">
          {/* Result State (when order is scanned and updated) */}
          {processedOrder ? (
            <div className="text-center space-y-6 animate-in zoom-in-95 duration-200">
              {/* Success Badge */}
              <div className="w-20 h-20 bg-emerald-100 text-emerald-600 rounded-3xl flex items-center justify-center mx-auto shadow-lg shadow-emerald-100 animate-bounce">
                <CheckCircle2 size={44} />
              </div>

              <div>
                <span className="px-3.5 py-1 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-black rounded-full inline-block mb-2">
                  تم التحديث بنجاح إلى: جاهز للاستلام ✅
                </span>
                <h4 className="text-2xl font-black text-slate-900 mb-1">
                  طلب #{processedOrder.order_number}
                </h4>
                <p className="text-sm font-bold text-slate-500">
                  العميل: <span className="text-slate-900 font-black">{processedOrder.customer_name}</span>
                </p>
              </div>

              {/* Order Info Summary Card */}
              <div className="p-5 bg-slate-50 rounded-2xl border border-slate-200 text-right space-y-3">
                <div className="flex justify-between items-center text-xs font-bold border-b border-slate-200 pb-2.5">
                  <span className="text-slate-400">رقم الجوال:</span>
                  <span className="text-slate-800 font-mono font-black" dir="ltr">{processedOrder.customer_phone || '-'}</span>
                </div>
                <div className="flex justify-between items-center text-xs font-bold border-b border-slate-200 pb-2.5">
                  <span className="text-slate-400">المبلغ الإجمالي:</span>
                  <span className="text-indigo-600 font-black text-sm">{processedOrder.total.toFixed(2)} ر.س</span>
                </div>
                <div className="flex justify-between items-center text-xs font-bold">
                  <span className="text-slate-400">حالة السداد:</span>
                  <span className={`font-black ${processedOrder.is_paid ? 'text-emerald-600' : 'text-amber-600'}`}>
                    {processedOrder.is_paid ? 'مدفوعة بالكامل ✅' : 'معلقة / غير مسددة ⏳'}
                  </span>
                </div>
              </div>

              {/* WhatsApp Notification Status Card */}
              {notificationStatus && (
                <div
                  className={`p-4 rounded-2xl border text-right space-y-2.5 animate-in fade-in duration-200 ${
                    notificationStatus.sent
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                      : 'bg-amber-50 border-amber-200 text-amber-900'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
                        notificationStatus.sent ? 'bg-emerald-100 text-emerald-600' : 'bg-amber-100 text-amber-600'
                      }`}
                    >
                      <Send size={16} />
                    </div>
                    <div className="flex-1">
                      <p className="text-xs font-black leading-relaxed">
                        {notificationStatus.message}
                      </p>
                    </div>
                  </div>

                  {!notificationStatus.sent && notificationStatus.waUrl && (
                    <div className="pt-2 border-t border-amber-200/60 flex items-center justify-between gap-2">
                      <span className="text-[11px] font-bold text-amber-800">
                        يمكنك إرسال الإشعار للعميل يدوياً بنقرة واحدة:
                      </span>
                      <a
                        href={notificationStatus.waUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-black shadow-xs transition-colors shrink-0"
                      >
                        <MessageSquare size={13} />
                        إرسال عبر واتساب 💬
                      </a>
                    </div>
                  )}
                </div>
              )}

              {/* Action Buttons */}
              <div className="grid grid-cols-2 gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleScanAnother}
                  className="p-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-black text-xs shadow-lg shadow-indigo-100 flex items-center justify-center gap-2 active:scale-95 transition-all cursor-pointer"
                >
                  <Camera size={16} />
                  مسح طلب آخر
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="p-4 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-2xl font-black text-xs active:scale-95 transition-all cursor-pointer"
                >
                  تم الانتهاء
                </button>
              </div>
            </div>
          ) : (
            /* Active Camera Scanner View */
            <div className="space-y-4">
              {/* Hardware & Camera Dual Mode Badge */}
              <div className="flex items-center justify-between p-3 bg-indigo-50/80 border border-indigo-100 rounded-2xl text-xs font-bold text-indigo-950">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                  <span>قارئ الباركود الحراري والكاميرا متصلان وجاهزان للمسح</span>
                </div>
                <span className="text-[10px] font-black bg-white text-indigo-800 border border-indigo-200 px-2 py-0.5 rounded-md shadow-xs">
                  مسح فوري ⚡
                </span>
              </div>

              {/* Camera Preview Container with Pinch-to-Zoom and Tap-to-Focus */}
              <div 
                className="relative rounded-3xl overflow-hidden bg-slate-950 aspect-square flex items-center justify-center border-4 border-slate-900 shadow-inner select-none touch-none"
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                onClick={handleTapToFocus}
              >
                {/* Hidden canvas for decoding */}
                <canvas ref={canvasRef} className="hidden" />

                {/* Video feed with hardware/digital zoom scaling */}
                <video
                  ref={videoRef}
                  className="w-full h-full object-cover"
                  autoPlay
                  playsInline
                  muted
                  disablePictureInPicture
                  style={{
                    transform: `scale(${zoomLevel})`,
                    transformOrigin: 'center center',
                    transition: 'transform 0.12s ease-out'
                  }}
                />

                {/* Optical Scanning Overlay */}
                <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center">
                  {/* Scanner Target Box with Corner Guides & Success Pulse */}
                  <div className={`w-64 h-64 border-2 rounded-3xl relative overflow-hidden shadow-2xl backdrop-brightness-110 transition-all duration-300 ${
                    scanSuccessPulse 
                      ? 'border-emerald-400 bg-emerald-500/20 shadow-[0_0_30px_#10b981]' 
                      : 'border-indigo-400/60'
                  }`}>
                    {/* Corner Reticles */}
                    <div className={`absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 rounded-tr-xl transition-colors ${scanSuccessPulse ? 'border-emerald-400' : 'border-indigo-400'}`} />
                    <div className={`absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 rounded-tl-xl transition-colors ${scanSuccessPulse ? 'border-emerald-400' : 'border-indigo-400'}`} />
                    <div className={`absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 rounded-br-xl transition-colors ${scanSuccessPulse ? 'border-emerald-400' : 'border-indigo-400'}`} />
                    <div className={`absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 rounded-bl-xl transition-colors ${scanSuccessPulse ? 'border-emerald-400' : 'border-indigo-400'}`} />

                    {/* Animated Scanning Laser Line */}
                    {isScanning && !isProcessing && !scanSuccessPulse && (
                      <div className="absolute inset-x-0 h-0.5 bg-gradient-to-r from-transparent via-indigo-400 to-transparent shadow-[0_0_12px_#818cf8] animate-pulse"
                        style={{
                          animation: 'scanLaser 2.2s infinite ease-in-out'
                        }}
                      />
                    )}

                    {/* Center Success Icon Pulse */}
                    {scanSuccessPulse && (
                      <div className="absolute inset-0 flex items-center justify-center animate-in zoom-in-50 duration-200">
                        <div className="p-4 rounded-full bg-emerald-500 text-white shadow-xl shadow-emerald-500/40 animate-bounce">
                          <Check size={36} className="stroke-[3]" />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Guide text & Active Zoom Indicator */}
                  <div className="mt-3 flex items-center gap-2">
                    <span className="px-3.5 py-1.5 rounded-full bg-slate-900/80 backdrop-blur-md text-white text-xs font-black shadow-md border border-white/10">
                      {isProcessing ? 'جاري معالجة الرمز والطلب...' : 'وجه الكاميرا نحو رمز QR أو الباركود'}
                    </span>
                    {zoomLevel > 1 && (
                      <span className="px-2 py-1 rounded-full bg-indigo-600/90 text-white text-[11px] font-black shadow-md font-mono">
                        {zoomLevel.toFixed(1)}x
                      </span>
                    )}
                  </div>
                </div>

                {/* Camera Top Controls */}
                <div className="absolute top-3 left-3 right-3 flex items-center justify-between pointer-events-auto">
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setSoundEnabled(!soundEnabled)}
                      className="p-2.5 rounded-xl bg-slate-900/70 hover:bg-slate-900 text-white backdrop-blur-sm transition-all text-xs flex items-center gap-1.5 cursor-pointer shadow-md"
                      title={soundEnabled ? 'كتم الصوت' : 'تفعيل صوت المسح'}
                    >
                      {soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
                    </button>

                    {/* Flashlight / Torch toggle button */}
                    {torchSupported && (
                      <button
                        type="button"
                        onClick={toggleTorch}
                        className={`p-2.5 rounded-xl backdrop-blur-sm transition-all text-xs flex items-center gap-1.5 cursor-pointer shadow-md ${
                          torchOn 
                            ? 'bg-amber-500 text-white shadow-amber-500/30 font-black' 
                            : 'bg-slate-900/70 hover:bg-slate-900 text-white'
                        }`}
                        title={torchOn ? 'إطفاء الفلاش' : 'تشغيل الفلاش'}
                      >
                        <Flashlight size={16} className={torchOn ? 'fill-current' : ''} />
                      </button>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={toggleFacingMode}
                    className="p-2.5 rounded-xl bg-slate-900/70 hover:bg-slate-900 text-white backdrop-blur-sm transition-all text-xs flex items-center gap-1.5 cursor-pointer shadow-md"
                    title="تبديل الكاميرا (أمامية / خلفية)"
                  >
                    <RotateCw size={16} />
                    <span className="text-[11px] font-bold">تبديل الكاميرا</span>
                  </button>
                </div>

                {/* Camera Bottom Zoom Controls */}
                <div className="absolute bottom-3 inset-x-3 flex items-center justify-center gap-1.5 pointer-events-auto">
                  <div className="flex items-center gap-1 bg-slate-900/80 backdrop-blur-md px-2 py-1.5 rounded-2xl border border-white/10 shadow-xl">
                    {/* Zoom Out Button */}
                    <button
                      type="button"
                      onClick={() => applyZoom(zoomLevel - 0.5)}
                      disabled={zoomLevel <= zoomCapabilities.min}
                      className="p-1.5 rounded-xl text-white hover:bg-white/20 disabled:opacity-40 transition-all cursor-pointer"
                      title="تصغير الكاميرا"
                    >
                      <ZoomOut size={15} />
                    </button>

                    {/* Quick Preset Zoom Chips */}
                    {[1, 1.5, 2, 3].map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => applyZoom(preset)}
                        className={`px-2.5 py-1 rounded-xl text-[11px] font-black font-mono transition-all cursor-pointer ${
                          Math.abs(zoomLevel - preset) < 0.1
                            ? 'bg-indigo-600 text-white shadow-sm scale-105'
                            : 'text-slate-300 hover:text-white hover:bg-white/10'
                        }`}
                      >
                        {preset}x
                      </button>
                    ))}

                    {/* Zoom In Button */}
                    <button
                      type="button"
                      onClick={() => applyZoom(zoomLevel + 0.5)}
                      disabled={zoomLevel >= zoomCapabilities.max}
                      className="p-1.5 rounded-xl text-white hover:bg-white/20 disabled:opacity-40 transition-all cursor-pointer"
                      title="تكبير الكاميرا"
                    >
                      <ZoomIn size={15} />
                    </button>
                  </div>
                </div>
              </div>

              {/* Error Banner */}
              {cameraError && (
                <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl text-amber-900 text-xs font-bold flex items-start gap-2.5 text-right">
                  <AlertCircle size={18} className="text-amber-600 shrink-0 mt-0.5" />
                  <div className="flex-1 whitespace-pre-line leading-relaxed">
                    {cameraError}
                  </div>
                  <button
                    type="button"
                    onClick={() => startCamera()}
                    className="px-2.5 py-1 bg-amber-200/80 hover:bg-amber-300 text-amber-900 rounded-lg text-xs font-black shrink-0 transition-all"
                  >
                    إعادة المحاولة
                  </button>
                </div>
              )}

              {/* Manual Input Fallback */}
              <div className="pt-2 border-t border-slate-100">
                <form onSubmit={handleManualSubmit} className="space-y-2">
                  <div className="flex items-center justify-between text-xs font-bold text-slate-500">
                    <span>أو أدخل رقم الفاتورة يدوياً:</span>
                    <span className="text-[11px] text-slate-400">إذا كانت الكاميرا غير متوفرة</span>
                  </div>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <QrCode className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                      <input
                        type="text"
                        placeholder="مثال: ORD-1001 أو 1001"
                        value={manualInput}
                        onChange={e => setManualInput(e.target.value)}
                        className="w-full pr-10 pl-3 py-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-indigo-500 focus:bg-white text-xs font-bold font-mono transition-all"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={!manualInput.trim() || isProcessing}
                      className="px-4 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-xl text-xs font-black flex items-center gap-1.5 transition-all shrink-0 cursor-pointer"
                    >
                      {isProcessing ? <RefreshCw size={14} className="animate-spin" /> : <Check size={14} />}
                      تجهيز
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Laser Scanning Animation Style */}
      <style>{`
        @keyframes scanLaser {
          0% { top: 8%; }
          50% { top: 88%; }
          100% { top: 8%; }
        }
      `}</style>
    </div>
  );
};
