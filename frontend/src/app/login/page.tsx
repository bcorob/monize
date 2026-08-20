'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import '@/lib/zodConfig';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/store/authStore';
import { useDemoStore } from '@/store/demoStore';
import { authApi, AuthMethods } from '@/lib/auth';
import { TwoFactorVerify } from '@/components/auth/TwoFactorVerify';
import { AuthShell } from '@/components/auth/AuthShell';
import { IncompleteLogoutNotice } from '@/components/auth/IncompleteLogoutNotice';
import { clearLogoutIncomplete } from '@/lib/logout-state';
import { User } from '@/types/auth';
import { createLogger } from '@/lib/logger';
import { buildEmailSchema } from '@/lib/zod-helpers';

const logger = createLogger('Login');

const buildLoginSchema = (t: (key: string) => string, tc: (key: string) => string) => z.object({
  email: buildEmailSchema(tc),
  password: z.string().min(1, t('signIn.passwordRequired')),
  rememberMe: z.boolean(),
});

type LoginFormData = z.infer<ReturnType<typeof buildLoginSchema>>;

/**
 * Validate a `returnTo` query parameter so we can safely redirect after login.
 * Restricts to same-origin path-only values to prevent open-redirect abuse via
 * absolute URLs, protocol-relative URLs, or backslash tricks.
 */
function safeReturnTo(value: string | null): string | null {
  if (!value) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return null;
  }
  return value;
}

export default function LoginPage() {
  const t = useTranslations('auth');
  const tc = useTranslations('common');
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTo = safeReturnTo(searchParams?.get('returnTo') ?? null);
  const { login } = useAuthStore();
  const [isLoading, setIsLoading] = useState(false);
  const [twoFactorState, setTwoFactorState] = useState<{ tempToken: string } | null>(null);
  // Set when login is rejected because the account's email is unverified. The
  // password was already accepted, so we can prompt the user to verify/resend.
  const [emailNotVerified, setEmailNotVerified] = useState<{ email: string } | null>(null);
  const [isResending, setIsResending] = useState(false);
  const [authMethods, setAuthMethods] = useState<AuthMethods>({ local: true, oidc: false, registration: true, smtp: false, force2fa: false, demo: false });
  const [isLoadingMethods, setIsLoadingMethods] = useState(true);

  useEffect(() => {
    const fetchAuthMethods = async () => {
      try {
        const methods = await authApi.getAuthMethods();
        setAuthMethods(methods);
        useDemoStore.getState().setDemoMode(methods.demo ?? false);
      } catch (error) {
        // Default to local auth if we can't fetch methods
        logger.error('Failed to fetch auth methods:', error);
      } finally {
        setIsLoadingMethods(false);
      }
    };
    fetchAuthMethods();
  }, []);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<LoginFormData>({
    resolver: zodResolver(buildLoginSchema(t, tc)),
    defaultValues: { rememberMe: false },
  });

  // Pre-fill demo credentials when demo mode is active
  useEffect(() => {
    if (authMethods.demo) {
      reset({
        email: 'demo@monize.com',
        password: 'Demo123!',
      });
    }
  }, [authMethods.demo, reset]);

  const onSubmit = async (data: LoginFormData) => {
    setIsLoading(true);
    try {
      const response = await authApi.login(data);

      if (response.requires2FA && response.tempToken) {
        setTwoFactorState({ tempToken: response.tempToken });
        return;
      }

      if (response.emailNotVerified) {
        setEmailNotVerified({ email: data.email });
        return;
      }

      // Token is now in httpOnly cookie, not in response body. A fresh sign-in
      // supersedes whatever the previous session left behind, including a
      // logout the server never confirmed.
      clearLogoutIncomplete();
      login(response.user!, 'httpOnly');
      if (authMethods.demo) {
        toast.success(t('toasts.welcomeDemo'), { duration: 6000 });
      } else {
        toast.success(t('toasts.welcomeBack'));
      }
      if (response.user!.mustChangePassword) {
        router.push('/change-password');
      } else if (returnTo) {
        // Full-page navigation so server-side OAuth interaction routes see
        // the freshly issued auth_token cookie on the very next request.
        window.location.href = returnTo;
      } else {
        router.push('/dashboard');
      }
    } catch {
      // SECURITY: Use generic error message to prevent account enumeration
      toast.error(t('toasts.invalidCredentials'));
    } finally {
      setIsLoading(false);
    }
  };

  const handle2FAVerified = (user: User) => {
    clearLogoutIncomplete();
    login(user, 'httpOnly');
    if (authMethods.demo) {
      toast.success(t('toasts.welcomeDemo'), { duration: 6000 });
    } else {
      toast.success(t('toasts.welcomeBack'));
    }
    if (user.mustChangePassword) {
      router.push('/change-password');
    } else if (returnTo) {
      window.location.href = returnTo;
    } else {
      router.push('/dashboard');
    }
  };

  const handleResendVerification = async () => {
    if (!emailNotVerified) return;
    setIsResending(true);
    try {
      await authApi.resendVerification(emailNotVerified.email);
      toast.success(t('signIn.resendVerificationSuccess'));
    } catch {
      toast.error(t('signIn.resendVerificationError'));
    } finally {
      setIsResending(false);
    }
  };

  const handleOidcLogin = () => {
    // Stash returnTo so the OIDC callback page can resume the OAuth
    // consent flow (or wherever the user was originally going). The
    // password and 2FA paths can pass it inline; the OIDC redirect
    // bounces through an external IdP so we use sessionStorage, which
    // survives cross-origin navigation back to this same origin.
    if (returnTo) {
      try {
        sessionStorage.setItem('postLoginReturnTo', returnTo);
      } catch {
        // private mode etc — ignore, fall back to /dashboard
      }
    }
    authApi.initiateOidc();
  };

  if (isLoadingMethods) {
    return (
      <AuthShell plain>
        <div className="text-center text-gray-500 dark:text-gray-400">{tc('loading')}</div>
      </AuthShell>
    );
  }

  // If only OIDC is available, auto-redirect to OIDC
  if (!authMethods.local && authMethods.oidc) {
    return (
      <AuthShell
        title={t('signIn.title')}
        notices={<IncompleteLogoutNotice />}
        languagePicker
        showVersion
      >
        <div className="space-y-6 text-center">
          <p className="text-gray-600 dark:text-gray-400">
            {t('signIn.ssoIntro')}
          </p>
          <Button
            type="button"
            variant="primary"
            size="lg"
            onClick={handleOidcLogin}
            className="w-full"
          >
            <svg
              className="w-5 h-5 mr-2"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            {t('signIn.ssoButton')}
          </Button>
        </div>
      </AuthShell>
    );
  }

  if (twoFactorState) {
    return (
      <AuthShell languagePicker>
        <TwoFactorVerify
          tempToken={twoFactorState.tempToken}
          onVerified={handle2FAVerified}
          onCancel={() => setTwoFactorState(null)}
        />
      </AuthShell>
    );
  }

  if (emailNotVerified) {
    return (
      <AuthShell
        title={t('signIn.notVerifiedTitle')}
        notices={
          <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg p-4 text-center">
            <p className="text-sm text-amber-800 dark:text-amber-200">
              {t('signIn.notVerifiedMessage')}
            </p>
          </div>
        }
        languagePicker
      >
        <div className="space-y-3">
          <Button
            type="button"
            variant="primary"
            size="lg"
            isLoading={isResending}
            onClick={handleResendVerification}
            className="w-full"
          >
            {t('signIn.resendVerification')}
          </Button>
          <button
            type="button"
            onClick={() => setEmailNotVerified(null)}
            className="block w-full text-center font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
          >
            {t('backToSignIn')}
          </button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={t('signIn.title')}
      subtitle={
        authMethods.local && authMethods.registration && !authMethods.demo ? (
          <p>
            {t('signIn.orPrefix')}{' '}
            <Link
              href="/register"
              className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
            >
              {t('signIn.createAccount')}
            </Link>
          </p>
        ) : undefined
      }
      notices={
        <>
          <IncompleteLogoutNotice />
          {authMethods.demo && (
            <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg px-4 py-3 text-center text-sm text-amber-800 dark:text-amber-200">
              <p className="font-semibold">{t('demo.badge')}</p>
              <p className="mt-1">{t('demo.credentialsNote')}</p>
            </div>
          )}
        </>
      }
      languagePicker
      showVersion
    >
      <>
        {authMethods.local && (
          <form className="space-y-6" onSubmit={handleSubmit(onSubmit)}>
            <div className="space-y-4">
              <Input
                label={t('signIn.emailLabel')}
                type="email"
                autoComplete="email"
                error={errors.email?.message}
                {...register('email')}
              />

              <Input
                label={t('signIn.passwordLabel')}
                type="password"
                autoComplete="current-password"
                error={errors.password?.message}
                {...register('password')}
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <input
                  id="remember-me"
                  type="checkbox"
                  {...register('rememberMe')}
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded dark:border-gray-600 dark:bg-gray-800"
                />
                <label
                  htmlFor="remember-me"
                  className="ml-2 block text-sm text-gray-900 dark:text-gray-300"
                >
                  {t('signIn.rememberMe')}
                </label>
              </div>

              {authMethods.smtp && !authMethods.demo && (
                <div className="text-sm">
                  <Link
                    href="/forgot-password"
                    className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
                  >
                    {t('signIn.forgotPassword')}
                  </Link>
                </div>
              )}
            </div>

            <div className="space-y-3">
              <Button
                type="submit"
                variant="primary"
                size="lg"
                isLoading={isLoading}
                className="w-full"
              >
                {authMethods.demo ? t('signIn.tryDemo') : t('signIn.submit')}
              </Button>

              {authMethods.oidc && (
                <>
                  <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                      <div className="w-full border-t border-gray-300 dark:border-gray-700" />
                    </div>
                    <div className="relative flex justify-center text-sm">
                      <span className="px-2 bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400">
                        {t('signIn.orContinueWith')}
                      </span>
                    </div>
                  </div>

                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    onClick={handleOidcLogin}
                    className="w-full"
                  >
                    <svg
                      className="w-5 h-5 mr-2"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                    {t('signIn.ssoButton')}
                  </Button>
                </>
              )}
            </div>
          </form>
        )}

        {!authMethods.local && !authMethods.oidc && (
          <div className="text-center text-red-600 dark:text-red-400">
            {t('signIn.noMethods')}
          </div>
        )}
      </>
    </AuthShell>
  );
}
