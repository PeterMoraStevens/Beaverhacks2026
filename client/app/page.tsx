"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function SplashPage() {
  const router = useRouter();
  const [visible, setVisible] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 100);
    return () => clearTimeout(t);
  }, []);

  const enter = () => {
    setLeaving(true);
    setTimeout(() => router.push("/map"), 700);
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "#0A0A0A",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      fontFamily: "'Arial Black', system-ui, sans-serif",
      opacity: leaving ? 0 : 1, transition: "opacity 0.7s ease", overflow: "hidden",
    }}>

      {/* Red glow */}
      <div style={{
        position: "absolute", top: "50%", left: "50%",
        transform: "translate(-50%, -60%)", width: 800, height: 800, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(230,57,70,0.12) 0%, transparent 65%)",
        pointerEvents: "none",
      }} />

      {/* Top red bar */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 4,
        background: "#E63946",
        opacity: visible ? 1 : 0, transition: "opacity 0.5s ease 0s",
      }} />

      {/* Red dot */}
      <div style={{
        width: 14, height: 14, borderRadius: "50%", background: "#E63946", marginBottom: 28,
        boxShadow: "0 0 20px rgba(230,57,70,0.6)",
        opacity: visible ? 1 : 0,
        transform: visible ? "scale(1)" : "scale(0)",
        transition: "opacity 0.5s ease 0.2s, transform 0.5s cubic-bezier(0.34,1.56,0.64,1) 0.2s",
      }} />

      {/* PANOPTICON */}
      <h1 style={{
        fontSize: "clamp(52px, 11vw, 108px)", fontWeight: 900, color: "#FFFFFF",
        letterSpacing: "0.18em", margin: 0, lineHeight: 1,
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(24px)",
        transition: "opacity 0.7s ease 0.3s, transform 0.7s ease 0.3s",
      }}>
        PANOPTICON
      </h1>

      {/* Animated red line */}
      <div style={{
        height: 3, width: visible ? 320 : 0,
        background: "linear-gradient(90deg, transparent, #E63946, transparent)",
        marginTop: 20, marginBottom: 28,
        transition: "width 0.9s ease 0.7s",
      }} />

      {/* Tagline — red */}
      <p style={{
        fontSize: "clamp(15px, 2.2vw, 20px)", color: "#E63946", margin: 0,
        fontWeight: 700, textAlign: "center", letterSpacing: "0.04em",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(12px)",
        transition: "opacity 0.7s ease 0.8s, transform 0.7s ease 0.8s",
      }}>
        Know who's watching before you walk out the door.
      </p>

      {/* Sub description */}
      <p style={{
        fontSize: "clamp(14px, 1.8vw, 18px)", color: "#999",
        margin: "16px 0 52px", textAlign: "center", maxWidth: 700, lineHeight: 1.8,
        fontFamily: "system-ui, sans-serif", fontWeight: 400,
        opacity: visible ? 1 : 0, transition: "opacity 0.7s ease 1.0s",
        padding: "0 24px",
      }}>
        Real-time surveillance camera density along any route 
      </p>

      {/* Enter button — outline style, fills red on hover */}
      <button
        onClick={enter}
        style={{
          background: "transparent", color: "#E63946", border: "2px solid #E63946",
          padding: "16px 56px", borderRadius: 4, fontSize: 15, fontWeight: 700,
          cursor: "pointer", letterSpacing: "0.15em", textTransform: "uppercase" as const,
          fontFamily: "'Arial Black', system-ui, sans-serif",
          opacity: visible ? 1 : 0,
          transform: visible ? "translateY(0)" : "translateY(12px)",
          transition: "opacity 0.7s ease 1.1s, transform 0.7s ease 1.1s, background 0.2s, color 0.2s, box-shadow 0.2s",
        }}
        onMouseEnter={(e) => {
          const b = e.currentTarget;
          b.style.background = "#E63946";
          b.style.color = "#fff";
          b.style.boxShadow = "0 0 32px rgba(230,57,70,0.5)";
        }}
        onMouseLeave={(e) => {
          const b = e.currentTarget;
          b.style.background = "transparent";
          b.style.color = "#E63946";
          b.style.boxShadow = "none";
        }}
      >
        Enter
      </button>

      {/* Bottom credit */}
      <p style={{
        position: "absolute", bottom: 20, fontSize: 11, color: "#333", margin: 0,
        letterSpacing: "0.2em", textTransform: "uppercase" as const,
        fontFamily: "system-ui, sans-serif",
        opacity: visible ? 1 : 0, transition: "opacity 0.7s ease 1.3s",
      }}>
        BeaverHacks 2026
      </p>
    </div>
  );
}