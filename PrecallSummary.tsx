import { useCallback, useEffect, useMemo, useState } from 'react';
import styles from './PrecallSummary.module.css';
import Card from '../Card/Card';
import { getPrecallSummary, fetchSpanLeadInfo } from '../../utilities/helpers/apiUtils';
import type { PrecallEvent, PrecallResponse, SpanLeadInfo } from '../../utilities/helpers/apiUtils';
import { retryAsync } from '../../utilities/helpers/retryUtils';
import { useSectionRenderTiming } from '../../analytics/useSectionRenderTiming';
import { appIdToCrmApp } from '../../utilities/helpers/commonUtils';
import { getAnalyticsBaseFields } from '../../analytics/analyticsContext';


type PreCallPayload = {
  type: 'pre-call';
  data: {
    gucid: string;
  };
};

type PrecallSummaryProps = {
  payload: PreCallPayload | null;
  lob: string | null;
  msid: string | null;
  appId?: string;
};

const MAX_AUTO_RETRIES = 2; // Auto-retry up to 2 times (3 total attempts)
const RETRY_DELAY_MS = 1000; // 1 second delay between retries

type FeedbackType = 'up' | 'down' | null;

// Parse **text** into bold and return React elements
const parseTextWithBold = (text: string): React.ReactNode[] => {
  const parts = text.split(/(\*\*[^*]+\*\*)/);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      const boldText = part.slice(2, -2);
      return <strong key={index}>{boldText}</strong>;
    }
    return part;
  });
};

// Parse summaryText into bullet items, excluding VAP's no-info sentinel
const NO_SUBSTANTIVE_INFO_PATTERN = /no substantive information/i;

const parseBullets = (text: string): string[] => {
  if (!text) return [];
  
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-') && !NO_SUBSTANTIVE_INFO_PATTERN.test(line))
    .map((line) => line.slice(1).trim());
};

const PrecallSummary = ({ payload, lob, msid, appId }: PrecallSummaryProps) => {
  const [events, setEvents] = useState<PrecallEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackType>(null);
  const [feedbackReason, setFeedbackReason] = useState<string | null>(null);
  const [otherText, setOtherText] = useState('');
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);
  const [spanLeadInfo, setSpanLeadInfo] = useState<SpanLeadInfo | null>(null);

  const gucid = payload?.data?.gucid?.trim();
  const crmApp = appIdToCrmApp(appId ?? '');


  useSectionRenderTiming('Contact Reason', {
    appId,
    ready: Boolean(payload),
    extra: { gucid: gucid ?? '' },
  });

  const fetchPrecall = useCallback(async () => {
    if (!gucid) {
      setEvents([]);
      setError(null);
      setLoading(false);
      setNotFound(false);
      return;
    }

    setLoading(true);
    setError(null);
    setNotFound(false);

    try {
      const response: PrecallResponse = await retryAsync(
        () => getPrecallSummary({ gucid }),
        {
          retries: MAX_AUTO_RETRIES,
          delayMs: RETRY_DELAY_MS,
          onRetry: (attemptNumber, maxRetries) => {
            console.log(`[PrecallSummary] Auto-retry attempt ${attemptNumber}/${maxRetries}`);
          },
        },
      );

      if (response.success && response.data) {
        if (response.data.found === false) {
          setNotFound(true);
          setEvents([]);
        } else {
          setEvents(response.data.events ?? []);
        }
      } else {
        throw new Error(response.error || 'Failed to fetch precall summary');
      }
    } catch {
      setError('Failed to fetch precall summary');
      setLoading(false);
      return;
    }
    
    setLoading(false);
  }, [gucid]);

  useEffect(() => {
    void fetchPrecall();
  }, [fetchPrecall]);

  // Fetch span leads / advocate group using the agent's msid
  useEffect(() => {
    if (!msid) return;

    fetchSpanLeadInfo(msid).then((info) => {
      if (info) {
        console.log('[PrecallSummary] Span leads info fetched:', info);
        setSpanLeadInfo(info);
      }
    });
  }, [msid]);

  const handleRetry = () => {
    void fetchPrecall();
  };

  const handleFeedbackReason = (reason: string) => {
    setFeedbackReason(reason);

    const eventData = {
      eventName: 'Contact Reason Feedback Detail',
      feedbackReason: reason,
      crmApp: crmApp,
      launchLocationScreen: getAnalyticsBaseFields().launchLocationScreen,
      gucid: gucid,
      lob: lob,
      msid: msid,
      ...spanLeadInfo,
      timestamp: new Date().toISOString(),
    };

    console.log('[PrecallSummary] Feedback reason event data:', eventData);

    if (typeof window !== 'undefined' && window.Rakanto) {
      console.log('[PrecallSummary] Sending feedback reason event to Rakanto/Kibana');
      window.Rakanto('sendCustomData', {
        namespace: 'UHG.UHC.UHCMR.UHCContactCenter',
        data: eventData,
      });
    }

    if (reason !== 'Other') {
      setFeedbackSubmitted(true);
    }
  };

  const handleOtherSend = () => {
    const eventData = {
      eventName: 'Contact Reason Feedback Detail',
      feedbackReason: 'Other',
      ...(otherText.trim() && { feedbackMessage: otherText.trim() }),
      crmApp: crmApp,
      launchLocationScreen: getAnalyticsBaseFields().launchLocationScreen,
      gucid: gucid,
      lob: lob,
      msid: msid,
      ...spanLeadInfo,
      timestamp: new Date().toISOString(),
    };

    console.log('[PrecallSummary] Other feedback event data:', eventData);

    if (typeof window !== 'undefined' && window.Rakanto) {
      console.log('[PrecallSummary] Sending Other feedback event to Rakanto/Kibana');
      window.Rakanto('sendCustomData', {
        namespace: 'UHG.UHC.UHCMR.UHCContactCenter',
        data: eventData,
      });
    }

    setFeedbackSubmitted(true);
  };

  const handleFeedback = (type: 'up' | 'down') => {
    const feedbackType = type === 'up' ? 'thumbs_up' : 'thumbs_down';

    setFeedback(type);
    if (type === 'up') setFeedbackSubmitted(true);

    const eventData = {
      eventName: 'Contact Reason Feedback',
      feedbackType: feedbackType,
      crmApp: crmApp,
      launchLocationScreen: getAnalyticsBaseFields().launchLocationScreen,
      gucid: gucid,
      lob: lob,
      msid: msid,
      ...spanLeadInfo,
      timestamp: new Date().toISOString(),
    };

    console.log('[PrecallSummary] Feedback event data:', eventData);

    // Send event to Kibana via Rakanto
    if (typeof window !== 'undefined' && window.Rakanto) {
      console.log('[PrecallSummary] Sending feedback event to Rakanto/Kibana');
      window.Rakanto('sendCustomData', {
        namespace: 'UHG.UHC.UHCMR.UHCContactCenter',
        data: eventData,
      });
    }
  };

  const rawSummaryText = events?.[0]?.summaryText;
  const summaryText = rawSummaryText?.trim() || '';
  // Strip leading "- " from VAP's no-info sentinel so it renders as clean plain text
  const displaySummaryText = NO_SUBSTANTIVE_INFO_PATTERN.test(summaryText)
    ? summaryText.replace(/^-\s*/, '')
    : summaryText;
  const bullets = useMemo(() => parseBullets(summaryText), [summaryText]);

  if (!payload) return null;

  // 404: no DynamoDB record → custom message
  const showNotFound = !loading && !error && notFound;
  const showSuccess = !loading && !error && !notFound && summaryText;
  const showFeedback = showNotFound || Boolean(showSuccess);

  return (
    <div className={styles.cardContainer}>
      <Card>
        {/* Header */}
        <div className={styles.header}>
        <svg width="20" height="20" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M2.6364 1.3636L2 0L1.3636 1.3636L0 2L1.3636 2.6364L2 4L2.6364 2.6364L4 2L2.6364 1.3636Z" fill="#F5B700"/>
        <path d="M6.5 1C6.70534 1 6.8898 1.12554 6.96513 1.31655L8.29967 4.70033L11.6834 6.03487C11.8745 6.1102 12 6.29466 12 6.5C12 6.70534 11.8745 6.8898 11.6834 6.96513L8.29967 8.29967L6.96513 11.6834C6.8898 11.8745 6.70534 12 6.5 12C6.29466 12 6.1102 11.8745 6.03487 11.6834L4.70033 8.29967L1.31655 6.96513C1.12554 6.8898 1 6.70534 1 6.5C1 6.29466 1.12554 6.1102 1.31655 6.03487L4.70033 4.70033L6.03487 1.31655C6.1102 1.12554 6.29466 1 6.5 1Z" fill="#F5B700"/>
        </svg>

        <h4 className={styles.headerTitle}>Contact reason</h4>
        </div>

        <div className={styles.divider} />

      {/* Body states */}
      {!gucid && (
        <p className={styles.noData}>No contact reason provided</p>
      )}

      {loading && <p className={styles.loading}>Loading contact reason...</p>}

      {!loading && error && (
        <div className={styles.errorContainer}>
          <p className={styles.errorText}>Unable to retrieve contact reason.</p>
          <button type="button" className={styles.retryBtn} onClick={handleRetry}>
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M7.125 0C5.11301 0 3.29684 0.833434 2 2.1748V0.125H0V4.5C0 4.7666 0.106629 5.0222 0.295898 5.20996C0.485113 5.39761 0.741334 5.50208 1.00781 5.5L5.38281 5.46484L5.36719 3.46484L3.52246 3.47852C4.45032 2.56242 5.72261 2 7.125 2C9.95897 2 12.25 4.29103 12.25 7.125C12.25 9.95897 9.95897 12.25 7.125 12.25C4.29103 12.25 2 9.95897 2 7.125H0C0 11.0635 3.18647 14.25 7.125 14.25C11.0635 14.25 14.25 11.0635 14.25 7.125C14.25 3.18647 11.0635 0 7.125 0Z" fill="white"/>
            </svg>
            <span>Retry</span>
          </button>
        </div>
      )}

      {/* 404: no DynamoDB record for this gucid */}
      {showNotFound && (
        <p className={styles.infoMessage}>
          <strong>Call reason not identified.</strong> Please continue with standard probing questions.
        </p>
      )}

      {!loading && !error && !notFound && summaryText && bullets.length > 0 && (
        <ul className={styles.bullets}>
          {bullets.map((item, idx) => (
            <li key={idx} className={styles.bulletItem}>
              {parseTextWithBold(item)}
            </li>
          ))}
        </ul>
      )}

      {!loading && !error && !notFound && summaryText && bullets.length === 0 && (
        <p className={styles.summaryText}>{parseTextWithBold(displaySummaryText)}</p>
      )}

      {/* Footer - show on success or info message state */}
      {showFeedback && (
        <>
          {feedbackSubmitted ? (
            <p className={styles.thanksText}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={styles.thanksIcon}>
                <path d="M10.6 13.8L8.45 11.65C8.26667 11.4667 8.03333 11.375 7.75 11.375C7.46667 11.375 7.23333 11.4667 7.05 11.65C6.86667 11.8333 6.775 12.0667 6.775 12.35C6.775 12.6333 6.86667 12.8667 7.05 13.05L9.9 15.9C10.1 16.1 10.3333 16.2 10.6 16.2C10.8667 16.2 11.1 16.1 11.3 15.9L16.95 10.25C17.1333 10.0667 17.225 9.83333 17.225 9.55C17.225 9.26667 17.1333 9.03333 16.95 8.85C16.7667 8.66667 16.5333 8.575 16.25 8.575C15.9667 8.575 15.7333 8.66667 15.55 8.85L10.6 13.8ZM12 22C10.6167 22 9.31667 21.7375 8.1 21.2125C6.88333 20.6875 5.825 19.975 4.925 19.075C4.025 18.175 3.3125 17.1167 2.7875 15.9C2.2625 14.6833 2 13.3833 2 12C2 10.6167 2.2625 9.31667 2.7875 8.1C3.3125 6.88333 4.025 5.825 4.925 4.925C5.825 4.025 6.88333 3.3125 8.1 2.7875C9.31667 2.2625 10.6167 2 12 2C13.3833 2 14.6833 2.2625 15.9 2.7875C17.1167 3.3125 18.175 4.025 19.075 4.925C19.975 5.825 20.6875 6.88333 21.2125 8.1C21.7375 9.31667 22 10.6167 22 12C22 13.3833 21.7375 14.6833 21.2125 15.9C20.6875 17.1167 19.975 18.175 19.075 19.075C18.175 19.975 17.1167 20.6875 15.9 21.2125C14.6833 21.7375 13.3833 22 12 22ZM12 20C14.2333 20 16.125 19.225 17.675 17.675C19.225 16.125 20 14.2333 20 12C20 9.76667 19.225 7.875 17.675 6.325C16.125 4.775 14.2333 4 12 4C9.76667 4 7.875 4.775 6.325 6.325C4.775 7.875 4 9.76667 4 12C4 14.2333 4.775 16.125 6.325 17.675C7.875 19.225 9.76667 20 12 20Z" fill="#007000"/>
              </svg>
              <span>Thank you for your feedback</span>
            </p>
          ) : (
            <div className={styles.footer}>
              <span className={styles.helpfulText}>Is this helpful?</span>

              <button
                type="button"
                className={`${styles.helpfulBtn} ${feedback === 'up' ? styles.helpfulBtnActive : ''}`}
                onClick={() => handleFeedback('up')}
              >
                <svg width="20" height="20" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M6.57812 1.93634C7.60909 0.390202 9.99962 1.1254 10 2.97052V6.1004H13.1201C14.4122 6.10048 15.301 7.36876 14.8984 8.57697V8.57892L13.2979 13.3484L13.2959 13.3563C12.9384 14.3956 11.9614 15.1003 10.8604 15.1004H1C0.447715 15.1004 0 14.6527 0 14.1004V6.1004C0.000301778 5.54837 0.447901 5.1004 1 5.1004H4.46484L6.57812 1.93536V1.93634ZM6 6.40411V13.1004H10.8604C11.0988 13.1003 11.3217 12.946 11.4043 12.7059L12.9492 8.1004H9C8.44772 8.1004 8 7.65269 8 7.1004V3.40704L6 6.40411ZM2 7.1004V13.1004H4V7.1004H2Z" fill="#424650"/>
                </svg>
                <span>Yes</span>
              </button>

              <button
                type="button"
                className={`${styles.helpfulBtn} ${feedback === 'down' ? styles.helpfulBtnActive : ''}`}
                onClick={() => handleFeedback('down')}
              >
                <svg width="20" height="20" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M10.8604 1C11.8926 1.00015 12.8158 1.61976 13.2217 2.55371L13.2959 2.74512L13.2979 2.75195L14.8984 7.52246V7.52344C15.3012 8.7317 14.4123 9.99992 13.1201 10H10V13.1299C10 14.9177 7.75628 15.664 6.67871 14.3027L6.57812 14.165L4.46484 11H1C0.447715 11 0 10.5523 0 10V2C0 1.44772 0.447715 1 1 1H10.8604ZM8.24121 13.0547L8.24219 13.0557C8.24219 13.0557 8.24083 13.0526 8.2373 13.0488L8.23633 13.0479L8.24121 13.0547ZM6 9.69531L8 12.6924V9C8 8.44772 8.44772 8 9 8H12.9492L11.4043 3.39453C11.3216 3.15463 11.0987 3.00016 10.8604 3H6V9.69531ZM2 9H4V3H2V9Z" fill="#424650"/>
                </svg>
                <span>No</span>
              </button>
            </div>
          )}

          {feedback === 'down' && !feedbackSubmitted && (
            <div className={styles.reasonSection}>
              <div className={styles.reasonDivider} />
              {feedbackReason === 'Other' ? (
                <div className={styles.otherInputRow}>
                  <input
                    type="text"
                    className={styles.otherInput}
                    placeholder="Type your feedback here..."
                    value={otherText}
                    onChange={(e) => setOtherText(e.target.value)}
                    onBlur={handleOtherSend}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleOtherSend(); }}
                  />
                  <button type="button" className={styles.otherSendBtn} onClick={handleOtherSend}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M0.312256 0.273499C0.616294 -0.014195 1.06788 -0.0818405 1.44312 0.103577L15.4431 7.03424C15.7825 7.20223 15.9981 7.54719 15.9998 7.92584C16.0013 8.30444 15.7888 8.6515 15.4509 8.82233L1.45093 15.8926C1.07573 16.082 0.621548 16.0163 0.315186 15.7286C0.0091759 15.4409 -0.0845345 14.9926 0.0808105 14.6065L2.91187 8.00006L0.0808105 1.39362C-0.0839295 1.00873 0.00826901 0.561391 0.312256 0.273499ZM4.65894 9.00006L2.99976 12.8682L10.6599 9.00006H4.65894ZM4.65894 7.00006H10.8669L2.98706 3.09967L4.65894 7.00006Z" fill="#126ECF"/>
                    </svg>
                  </button>
                </div>
              ) : (
                <div className={styles.reasonBtns}>
                  {(['Reason mismatch', 'Possible Inaccuracy', 'Other'] as const).map((reason) => (
                    <button
                      key={reason}
                      type="button"
                      className={`${styles.helpfulBtn} ${styles.reasonBtn} ${feedbackReason === reason ? styles.helpfulBtnActive : ''}`}
                      onClick={() => handleFeedbackReason(reason)}
                    >
                      {reason}
                      {reason === 'Other' && (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <path d="M5 19H6.425L16.2 9.225L14.775 7.8L5 17.575V19ZM4 21C3.71667 21 3.47917 20.9042 3.2875 20.7125C3.09583 20.5208 3 20.2833 3 20V17.575C3 17.3083 3.05 17.0542 3.15 16.8125C3.25 16.5708 3.39167 16.3583 3.575 16.175L16.2 3.575C16.4 3.39167 16.6208 3.25 16.8625 3.15C17.1042 3.05 17.3583 3 17.625 3C17.8917 3 18.15 3.05 18.4 3.15C18.65 3.25 18.8667 3.4 19.05 3.6L20.425 5C20.625 5.18333 20.7708 5.4 20.8625 5.65C20.9542 5.9 21 6.15 21 6.4C21 6.66667 20.9542 6.92083 20.8625 7.1625C20.7708 7.40417 20.625 7.625 20.425 7.825L7.825 20.425C7.64167 20.6083 7.42917 20.75 7.1875 20.85C6.94583 20.95 6.69167 21 6.425 21H4ZM15.475 8.525L14.775 7.8L16.2 9.225L15.475 8.525Z" fill="currentColor"/>
                        </svg>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className={styles.disclaimer}>
            AI-generated content may be incorrect
          </div>
        </>
      )}
      </Card>
    </div>
  );
};

export default PrecallSummary;
