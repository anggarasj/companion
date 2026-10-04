import { toast } from 'sonner'

type Kind = 'success' | 'error' | 'info'

const show = (kind: Kind, message: string): void => {
  toast[kind](message)
}

/** The call shape the app used with @meetcc/ui's toast, now drawn by sonner. */
export const useToast = () => show
