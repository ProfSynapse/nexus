import { ISessionService } from '../interfaces/IRequestHandlerServices';
import { SessionContextManager } from '../../services/SessionContextManager';
import { 
    generateSessionId, 
    isStandardSessionId 
} from '../../utils/sessionUtils';
import { logger } from '../../utils/logger';

export class SessionService implements ISessionService {
    async processSessionId(sessionId: string | undefined): Promise<{
        sessionId: string;
        isNewSession: boolean;
        isNonStandardId: boolean;
        originalSessionId?: string;
    }> {
        if (!sessionId) {
            const newSessionId = this.generateSessionId();
            logger.systemLog(`Created new session with standardized ID: ${newSessionId}`);
            
            return {
                sessionId: newSessionId,
                isNewSession: true,
                isNonStandardId: false
            };
        }
        
        if (!this.isStandardSessionId(sessionId)) {
            const standardizedId = this.generateSessionId();
            logger.systemLog(`Replaced non-standard session ID: ${sessionId} with standardized ID: ${standardizedId}`);
            
            return {
                sessionId: standardizedId,
                isNewSession: false,
                isNonStandardId: true,
                originalSessionId: sessionId
            };
        }
        
        return {
            sessionId,
            isNewSession: false,
            isNonStandardId: false
        };
    }

    generateSessionId(): string {
        return generateSessionId();
    }

    isStandardSessionId(sessionId: string): boolean {
        return isStandardSessionId(sessionId);
    }

    shouldInjectInstructions(
        sessionId: string, 
        sessionContextManager?: SessionContextManager
    ): boolean {
        return sessionContextManager ? 
            !sessionContextManager.hasReceivedInstructions(sessionId) : 
            false;
    }
}