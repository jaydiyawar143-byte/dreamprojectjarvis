"use client";

import { motion } from "framer-motion";
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { ConsoleField } from "./console-field";
import { ConsoleButton } from "./console-button";
import { riseIn, stagger } from "./motion";

type Errors = {
  name?: string;
  email?: string;
  password?: string;
  confirm?: string;
};

/**
 * New operator identity. Mirrors LoginForm's contract; the parent performs the
 * request. Password rules match the API's schema (min 8, max 128) so the user
 * is told locally rather than round-tripping for a 400.
 */
export function SignupForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (email: string, name: string, password: string) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Errors>({});

  function validate(): boolean {
    const next: Errors = {};
    if (!name.trim()) next.name = "Operator name required";
    else if (name.trim().length > 100) next.name = "Maximum 100 characters";

    if (!email.trim()) next.email = "Operator ID required";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) next.email = "Invalid operator ID format";

    if (!password) next.password = "Access key required";
    else if (password.length < 8) next.password = "Minimum 8 characters";
    else if (password.length > 128) next.password = "Maximum 128 characters";

    if (confirm !== password) next.confirm = "Access keys do not match";

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!validate()) return;
    onSubmit(email.trim(), name.trim(), password);
  }

  const clear = (k: keyof Errors) => {
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };

  return (
    <motion.form
      onSubmit={handleSubmit}
      variants={stagger(0.05, 0.06)}
      initial="hidden"
      animate="show"
      noValidate
      className="space-y-3.5"
    >
      <motion.div variants={riseIn()}>
        <ConsoleField
          label="Operator Name"
          type="text"
          value={name}
          onChange={(v) => {
            setName(v);
            clear("name");
          }}
          autoComplete="name"
          required
          disabled={busy}
          error={errors.name}
        />
      </motion.div>

      <motion.div variants={riseIn()}>
        <ConsoleField
          label="Email / Operator ID"
          type="email"
          value={email}
          onChange={(v) => {
            setEmail(v);
            clear("email");
          }}
          autoComplete="email"
          required
          disabled={busy}
          error={errors.email}
        />
      </motion.div>

      <motion.div variants={riseIn()}>
        <ConsoleField
          label="Create Access Key"
          type="password"
          value={password}
          onChange={(v) => {
            setPassword(v);
            clear("password");
          }}
          autoComplete="new-password"
          required
          minLength={8}
          disabled={busy}
          error={errors.password}
          hint="Minimum 8 characters"
        />
      </motion.div>

      <motion.div variants={riseIn()}>
        <ConsoleField
          label="Confirm Access Key"
          type="password"
          value={confirm}
          onChange={(v) => {
            setConfirm(v);
            clear("confirm");
          }}
          autoComplete="new-password"
          required
          disabled={busy}
          error={errors.confirm}
        />
      </motion.div>

      <motion.div variants={riseIn()} className="pt-2">
        <ConsoleButton type="submit" disabled={busy}>
          Initialize Identity
          <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </ConsoleButton>
      </motion.div>
    </motion.form>
  );
}
