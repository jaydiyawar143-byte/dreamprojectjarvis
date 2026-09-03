"use client";

import { motion } from "framer-motion";
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { ConsoleField } from "./console-field";
import { ConsoleButton } from "./console-button";
import { riseIn, stagger, BOOT } from "./motion";

export type FieldErrors = { email?: string; password?: string };

/**
 * Operator identification. Owns only its own inputs and client-side validation;
 * the network call belongs to the parent so the staged status overlay can be
 * driven from one place.
 */
export function LoginForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (email: string, password: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});

  function validate(): boolean {
    const next: FieldErrors = {};
    if (!email.trim()) next.email = "Operator ID required";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) next.email = "Invalid operator ID format";
    if (!password) next.password = "Access key required";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!validate()) return;
    onSubmit(email.trim(), password);
  }

  return (
    <motion.form
      onSubmit={handleSubmit}
      variants={stagger(BOOT.controls, 0.075)}
      initial="hidden"
      animate="show"
      noValidate
      className="space-y-4"
    >
      <motion.div variants={riseIn()}>
        <ConsoleField
          label="Operator ID / Email"
          type="email"
          value={email}
          onChange={(v) => {
            setEmail(v);
            if (errors.email) setErrors((e) => ({ ...e, email: undefined }));
          }}
          autoComplete="email"
          required
          disabled={busy}
          error={errors.email}
        />
      </motion.div>

      <motion.div variants={riseIn()}>
        <ConsoleField
          label="Access Key"
          type="password"
          value={password}
          onChange={(v) => {
            setPassword(v);
            if (errors.password) setErrors((e) => ({ ...e, password: undefined }));
          }}
          autoComplete="current-password"
          required
          disabled={busy}
          error={errors.password}
        />
      </motion.div>

      <motion.div variants={riseIn()} className="pt-2">
        <ConsoleButton type="submit" disabled={busy}>
          Initialize Access
          <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </ConsoleButton>
      </motion.div>
    </motion.form>
  );
}
